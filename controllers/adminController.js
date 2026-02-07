/* eslint-disable node/no-unsupported-features/es-syntax */
/* eslint-disable node/no-unsupported-features/node-builtins */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */
/**
 * Admin Controller
 * Handles document ingestion and knowledge base updates
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Advanced text splitter using LangChain RecursiveCharacterTextSplitter
 */
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');

const splitTextIntoChunks = async (text) => {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
    separators: ['\n\n', '\n', '.', ' '],
  });
  const docs = await splitter.createDocuments([text]);
  return docs.map((d) => d.pageContent.trim()).filter((c) => c.length > 0);
};

// Local disk storage for uploaded files
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

const resolveUploadPath = (fileName) => {
  // prevent path traversal and allow subfolders
  const resolved = path.resolve(UPLOAD_ROOT, fileName);
  if (!resolved.startsWith(UPLOAD_ROOT)) {
    throw new Error('Invalid file path');
  }
  return resolved;
};

// In-memory ingest job tracker (simple, non-persistent)
const ingestJobs = new Map();

const newJobId = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto
    .createHash('sha1')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex');
};

const setJobStatus = (jobId, payload) => {
  const prev = ingestJobs.get(jobId) || {};
  const next = { ...prev, ...payload, updatedAt: new Date().toISOString() };
  ingestJobs.set(jobId, next);
  return next;
};

const resolveFolderPath = (folderName) => {
  const resolved = path.resolve(UPLOAD_ROOT, folderName);
  if (!resolved.startsWith(UPLOAD_ROOT)) {
    throw new Error('Invalid folder path');
  }
  return resolved;
};

const saveBufferToDisk = async (fileName, buffer) => {
  const targetPath = resolveUploadPath(fileName);
  console.log(`[FILE SAVE] Saving file to: ${targetPath}`);
  try {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    console.log(`[FILE SAVE] Created directory: ${path.dirname(targetPath)}`);
    await fs.promises.writeFile(targetPath, buffer);
    console.log(
      `[FILE SAVE] Successfully saved ${buffer.length} bytes to ${targetPath}`,
    );
    return targetPath;
  } catch (err) {
    console.error(`[FILE SAVE] Error saving file: ${err.message}`, err);
    throw err;
  }
};

// PDF parsing & OCR helpers
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const pdfConverter = require('pdf-img-convert');
const embeddingService = require('../services/embeddingService');
const localDbClient = require('../client/localDbClient');

const extractTextWithPdfParse = async (buffer) => {
  try {
    const result = await pdfParse(buffer);
    return (result.text || '').trim();
  } catch (e) {
    return '';
  }
};

/**
 * OCR PDF pages using pdf-img-convert + Tesseract
 * Converts each page to PNG then runs OCR
 */
const ocrPdfPages = async (buffer) => {
  try {
    console.log('[OCR] Converting PDF pages to images...');
    // Convert PDF pages to PNG images (returns array of buffers)
    const pngPages = await pdfConverter.convert(buffer, {
      width: 2000, // High resolution for better OCR
      height: 2000,
      page_numbers: undefined, // Convert all pages
    });

    console.log(`[OCR] Converted ${pngPages.length} pages, starting OCR...`);

    const pageTexts = [];
    for (let i = 0; i < pngPages.length; i += 1) {
      const pngBuffer = pngPages[i];
      console.log(`[OCR] Processing page ${i + 1}/${pngPages.length}...`);

      // eslint-disable-next-line no-await-in-loop
      const { data: ocr } = await Tesseract.recognize(pngBuffer, 'eng', {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            console.log(
              `[OCR] Page ${i + 1}: ${Math.round(m.progress * 100)}%`,
            );
          }
        },
      });

      pageTexts.push((ocr.text || '').trim());
    }

    console.log('[OCR] Completed all pages');
    return pageTexts;
  } catch (error) {
    console.error('[OCR] Error during OCR processing:', error);
    throw error;
  }
};

/**
 * POST /admin/ingest
 * Ingest a document (PDF text extracted as JSON, or plain text)
 * Body: { fileName, text, metadata: { author, version, etc } }
 */
exports.ingestDocument = async (req, res) => {
  try {
    const { fileName, text, metadata = {} } = req.body;

    if (!fileName || !text) {
      return res.status(400).json({ error: 'fileName and text are required' });
    }

    // Split text into chunks (LangChain)
    const chunks = await splitTextIntoChunks(text);
    console.log(`Ingesting ${fileName} with ${chunks.length} chunk(s)`);

    // Insert each chunk with embedding
    const insertedIds = [];
    for (let i = 0; i < chunks.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await embeddingService.insertChunk(
        localDbClient,
        chunks[i],
        fileName,
        { ...metadata, chunkIndex: i },
      );
      insertedIds.push(result.id);
    }

    return res.status(201).json({
      message: 'Document ingested successfully',
      fileName,
      chunksIngested: insertedIds.length,
      ids: insertedIds,
    });
  } catch (error) {
    console.error('Error ingesting document:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /admin/update-page
 * Update content for a specific page
 * Body: { fileName, pageNumber, newText, metadata: { ... } }
 *
 * Atomic operation:
 * 1. Delete all chunks for this page
 * 2. Split new text and insert with updated metadata
 */
exports.updatePage = async (req, res) => {
  try {
    const { fileName, pageNumber, newText, metadata = {} } = req.body;

    if (!fileName || pageNumber === undefined || !newText) {
      return res.status(400).json({
        error: 'fileName, pageNumber, and newText are required',
      });
    }

    console.log(`Updating ${fileName} page ${pageNumber}`);

    // Step 1: Delete old page vectors
    await embeddingService.deletePageVectors(
      localDbClient,
      fileName,
      pageNumber,
    );
    console.log(`Deleted old vectors for ${fileName} page ${pageNumber}`);

    // Step 2: Split new text and insert with updated metadata
    const chunks = await splitTextIntoChunks(newText);
    const insertedIds = [];

    for (let i = 0; i < chunks.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await embeddingService.insertChunk(
        localDbClient,
        chunks[i],
        fileName,
        {
          ...metadata,
          page: pageNumber,
          chunkIndex: i,
          updatedAt: new Date().toISOString(),
        },
      );
      insertedIds.push(result.id);
    }

    console.log(
      `Re-inserted ${insertedIds.length} chunk(s) for ${fileName} page ${pageNumber}`,
    );

    return res.status(200).json({
      message: 'Page updated successfully',
      fileName,
      pageNumber,
      chunksInserted: insertedIds.length,
      ids: insertedIds,
    });
  } catch (error) {
    console.error('Error updating page:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /admin/ingest-pdf
 * Ingest a PDF upload with OCR fallback and page-aware metadata
 * Multipart: field name 'pdf'
 */
exports.ingestPdf = async (req, res) => {
  try {
    const { file } = req;
    if (!file) {
      return res.status(400).json({ error: 'No PDF uploaded' });
    }

    const jobId = newJobId();
    const fileName = file.originalname;
    const { buffer } = file;
    // Check if file already exists in database
    const existingFile = await localDbClient.query(
      'SELECT COUNT(*) as count FROM knowledge_base WHERE source_file = $1',
      [fileName],
    );
    if (existingFile.rows[0].count > 0) {
      return res.status(409).json({
        error:
          'A file with this name already exists. Please rename your file or delete the existing one.',
      });
    }

    // Check if file already exists on disk
    const filePath = resolveUploadPath(fileName);
    if (fs.existsSync(filePath)) {
      return res.status(409).json({
        error:
          'A file with this name already exists on disk. Please rename your file or delete the existing one.',
      });
    }
    setJobStatus(jobId, {
      status: 'queued',
      progress: 0,
      message: 'Queued',
      fileName,
    });

    // Respond immediately so the client doesn’t hit gateway timeouts
    res.status(202).json({ jobId, status: 'queued', fileName });

    // Process asynchronously
    setImmediate(async () => {
      try {
        setJobStatus(jobId, {
          status: 'uploading',
          progress: 5,
          message: 'Saving PDF',
        });
        const savedPath = await saveBufferToDisk(fileName, buffer);
        console.log(`[INGEST PDF] File persisted to: ${savedPath}`);

        setJobStatus(jobId, {
          status: 'parsing',
          progress: 10,
          message: 'Extracting text',
        });
        const extracted = await extractTextWithPdfParse(buffer);

        let pageTexts = [];
        if (!extracted || extracted.length < 50) {
          setJobStatus(jobId, {
            status: 'ocr',
            progress: 30,
            message: 'Running OCR (may take a while)',
          });
          pageTexts = await ocrPdfPages(buffer);
        } else {
          pageTexts = [extracted];
        }

        const insertedIds = [];
        const totalPages = pageTexts.length || 1;
        for (let p = 0; p < pageTexts.length; p += 1) {
          const pageText = pageTexts[p];
          if (!pageText || pageText.trim().length === 0) continue; // eslint-disable-line no-continue

          const pageBase = 40 + Math.floor((p / totalPages) * 40); // 40-80% during chunking
          // eslint-disable-next-line no-await-in-loop
          const chunks = await splitTextIntoChunks(pageText);
          for (let i = 0; i < chunks.length; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const result = await embeddingService.insertChunk(
              localDbClient,
              chunks[i],
              fileName,
              { page: p + 1, chunkIndex: i, chunkNumber: i + 1 },
            );
            insertedIds.push(result.id);
          }
          const pageProgress =
            pageBase + Math.min(40, Math.floor(((p + 1) / totalPages) * 40));
          setJobStatus(jobId, {
            status: 'embedding',
            progress: Math.min(90, pageProgress),
            message: `Embedding page ${p + 1}/${totalPages}`,
          });
        }

        setJobStatus(jobId, {
          status: 'completed',
          progress: 100,
          message: 'PDF ingested',
          fileName,
          chunksIngested: insertedIds.length,
          pagesProcessed: pageTexts.length,
        });
      } catch (error) {
        console.error('Error ingesting PDF (async):', error);
        setJobStatus(jobId, {
          status: 'failed',
          progress: 100,
          message: error.message || 'Failed to ingest PDF',
        });
      }
    });
  } catch (error) {
    console.error('Error ingesting PDF:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  return undefined;
};

/**
 * GET /admin/knowledge-base/stats
 * Retrieve knowledge base statistics
 */
exports.getKnowledgeBaseStats = async (req, res) => {
  try {
    const sql = `
      SELECT
        COUNT(*) as total_chunks,
        COUNT(DISTINCT source_file) as total_files,
        ARRAY_AGG(DISTINCT source_file) as files,
        COUNT(DISTINCT metadata->>'page') as total_pages
      FROM knowledge_base;
    `;
    const { rows } = await localDbClient.query(sql);
    const stats = rows[0] || {
      total_chunks: 0,
      total_files: 0,
      files: [],
      total_pages: 0,
    };

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error fetching KB stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /admin/knowledge-base/files
 * Returns per-file overview: name, upload_date, chunk_number, enabled
 */
exports.getKnowledgeBaseFiles = async (req, res) => {
  try {
    // Get all files with their metadata
    const sql = `
      SELECT 
        source_file AS name,
        MIN(created_at) AS upload_date,
        COUNT(*) AS chunk_number,
        array_agg(metadata) AS all_metadata
      FROM knowledge_base
      GROUP BY source_file
      ORDER BY upload_date DESC;
    `;
    const { rows } = await localDbClient.query(sql);

    // Process rows to extract enabled status from metadata
    const processedRows = rows.map((row) => {
      let enabled = true; // Default to true if no metadata

      // Check if any chunk has enabled explicitly set to false
      if (row.all_metadata && Array.isArray(row.all_metadata)) {
        for (const meta of row.all_metadata) {
          if (meta && typeof meta === 'object' && meta.enabled === false) {
            enabled = false;
            break;
          }
        }
      }

      return {
        name: row.name,
        upload_date: row.upload_date,
        chunk_number: row.chunk_number,
        enabled,
      };
    });

    return res.status(200).json(processedRows || []);
  } catch (error) {
    console.error('Error fetching KB files:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /admin/knowledge-base/folders
 * List folder names derived from disk and DB
 */
exports.listFolders = async (req, res) => {
  try {
    const folderSet = new Set();

    // From DB (prefix before first slash)
    const { rows } = await localDbClient.query(
      `SELECT DISTINCT split_part(source_file, '/', 1) AS folder
       FROM knowledge_base
       WHERE position('/' in source_file) > 0;`,
    );
    rows.forEach((r) => {
      if (r.folder) folderSet.add(r.folder);
    });

    // From disk directories
    const dirEntries = await fs.promises.readdir(UPLOAD_ROOT, {
      withFileTypes: true,
    });
    dirEntries.forEach((dirent) => {
      if (dirent.isDirectory()) folderSet.add(dirent.name);
    });

    const folders = Array.from(folderSet).sort((a, b) => a.localeCompare(b));
    return res.status(200).json({ folders });
  } catch (error) {
    console.error('Error listing folders:', error);
    return res.status(500).json({ error: 'Failed to list folders' });
  }
};

/**
 * POST /admin/knowledge-base/folders
 * Body: { folderName }
 * Creates a folder on disk (no DB rows created)
 */
exports.createFolder = async (req, res) => {
  try {
    const { folderName } = req.body;
    if (!folderName || typeof folderName !== 'string' || !folderName.trim()) {
      return res.status(400).json({ error: 'folderName is required' });
    }
    const safeName = folderName.trim();
    const folderPath = resolveFolderPath(safeName);

    // Check if folder already exists
    if (fs.existsSync(folderPath)) {
      return res
        .status(409)
        .json({ error: 'Folder with this name already exists' });
    }

    await fs.promises.mkdir(folderPath, { recursive: true });
    return res
      .status(201)
      .json({ message: 'Folder created', folderName: safeName });
  } catch (error) {
    console.error('Error creating folder:', error);
    return res.status(500).json({ error: 'Failed to create folder' });
  }
};

/**
 * DELETE /admin/knowledge-base/folders/:folderName
 * Deletes all files under a folder (DB + disk) and removes the folder
 */
exports.deleteFolder = async (req, res) => {
  try {
    const folderName = decodeURIComponent(req.params.folderName || '');
    if (!folderName) {
      return res.status(400).json({ error: 'folderName is required' });
    }

    // Delete DB rows for files within the folder
    const dbResult = await localDbClient.query(
      `DELETE FROM knowledge_base WHERE source_file LIKE $1`,
      [`${folderName}/%`],
    );

    // Delete folder from disk
    const folderPath = resolveFolderPath(folderName);
    let diskDeleted = false;
    if (fs.existsSync(folderPath)) {
      try {
        await fs.promises.rm(folderPath, { recursive: true, force: true });
        diskDeleted = true;
      } catch (fsError) {
        console.error('Failed to delete folder from disk:', fsError);
      }
    }

    return res.status(200).json({
      message: 'Folder deleted',
      folderName,
      rowsDeleted: dbResult.rowCount,
      diskDeleted,
    });
  } catch (error) {
    console.error('Error deleting folder:', error);
    return res.status(500).json({ error: 'Failed to delete folder' });
  }
};

/**
 * GET /admin/jobs/:jobId/status
 * Returns ingest job status
 */
exports.getIngestJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = ingestJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.status(200).json(job);
  } catch (error) {
    console.error('Error getting job status:', error);
    return res.status(500).json({ error: 'Failed to get job status' });
  }
};

/**
 * POST /admin/knowledge-base/:fileName/enable
 * Body: { enabled: boolean }
 * Sets enabled flag for all chunks of a file
 */
exports.setFileEnabled = async (req, res) => {
  try {
    const { fileName } = req.params;
    const { enabled } = req.body;
    if (!fileName || typeof enabled === 'undefined') {
      return res
        .status(400)
        .json({ error: 'fileName and enabled are required' });
    }

    // Get all chunks for this file
    const chunks = await localDbClient.query(
      'SELECT id, metadata FROM knowledge_base WHERE source_file = $1',
      [fileName],
    );

    // Update metadata for each chunk
    const updatePromises = chunks.rows.map(async (row) => {
      const metadata = row.metadata || {};
      metadata.enabled = enabled;
      await localDbClient.query(
        'UPDATE knowledge_base SET metadata = $1 WHERE id = $2',
        [JSON.stringify(metadata), row.id],
      );
    });

    await Promise.all(updatePromises);
    return res
      .status(200)
      .json({ message: 'File enabled state updated', fileName, enabled });
  } catch (error) {
    console.error('Error setting file enabled:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /admin/knowledge-base/:fileName/reembed
 * Recompute embeddings for all chunks in a file (refresh parsing)
 */
exports.reembedFile = async (req, res) => {
  try {
    const { fileName } = req.params;
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    const { rows } = await localDbClient.query(
      'SELECT id, content FROM knowledge_base WHERE source_file = $1 ORDER BY id ASC;',
      [fileName],
    );

    let updated = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      // eslint-disable-next-line no-await-in-loop
      const embedding = await embeddingService.generateEmbedding(row.content);
      const embeddingVector = `[${embedding.join(',')}]`;
      // eslint-disable-next-line no-await-in-loop
      await localDbClient.query(
        'UPDATE knowledge_base SET embedding = $2::vector WHERE id = $1;',
        [row.id, embeddingVector],
      );
      updated += 1;
    }

    return res.status(200).json({
      message: 'Re-embedded successfully',
      fileName,
      chunksUpdated: updated,
    });
  } catch (error) {
    console.error('Error re-embedding file:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Start parse job (async) for a file
 * POST /admin/knowledge-base/:fileName/parse
 */
exports.startParseFile = async (req, res) => {
  try {
    const { fileName } = req.params;
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    // Create job row
    const { rows: jobRows } = await localDbClient.query(
      `INSERT INTO kb_jobs (file_name, status, progress, start_time, last_message)
       VALUES ($1, 'running', 0, NOW(), 'Starting parse')
       RETURNING id;`,
      [fileName],
    );
    const jobId = jobRows[0].id;

    // Run job asynchronously (fire-and-forget)
    (async () => {
      try {
        const { rows } = await localDbClient.query(
          'SELECT id, content FROM knowledge_base WHERE source_file = $1 ORDER BY id ASC;',
          [fileName],
        );
        const total = rows.length || 1;
        let updated = 0;
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          const embedding = await embeddingService.generateEmbedding(
            row.content,
          );
          const embeddingVector = `[${embedding.join(',')}]`;
          await localDbClient.query(
            'UPDATE knowledge_base SET embedding = $2::vector WHERE id = $1;',
            [row.id, embeddingVector],
          );
          updated += 1;
          const progress = Math.round((updated / total) * 10000) / 100; // 2 decimals
          await localDbClient.query(
            `UPDATE kb_jobs SET progress = $2, last_message = $3 WHERE id = $1;`,
            [jobId, progress, `Updated ${updated}/${total} chunks`],
          );
        }
        await localDbClient.query(
          `UPDATE kb_jobs SET status = 'completed', end_time = NOW(), last_message = 'Completed' WHERE id = $1;`,
          [jobId],
        );
      } catch (e) {
        await localDbClient.query(
          `UPDATE kb_jobs SET status = 'failed', end_time = NOW(), last_message = $2 WHERE id = $1;`,
          [jobId, e.message || 'Failed'],
        );
      }
    })();

    return res.status(202).json({ message: 'Parse started', jobId, fileName });
  } catch (error) {
    console.error('Error starting parse:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get latest job status for a file
 * GET /admin/knowledge-base/:fileName/status
 */
exports.getFileStatus = async (req, res) => {
  try {
    const { fileName } = req.params;
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }
    const { rows } = await localDbClient.query(
      `SELECT id, file_name, status, progress, start_time, end_time, last_message
       FROM kb_jobs WHERE file_name = $1 ORDER BY start_time DESC LIMIT 1;`,
      [fileName],
    );
    if (!rows || rows.length === 0) {
      return res.status(200).json({ status: 'idle', progress: 0 });
    }
    const job = rows[0];
    return res.status(200).json(job);
  } catch (error) {
    console.error('Error getting job status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * DELETE /admin/knowledge-base/:fileName
 * Delete all chunks for a specific file
 */
exports.deleteDocument = async (req, res) => {
  try {
    const { fileName } = req.params;

    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    // Delete from database
    const sql = `DELETE FROM knowledge_base WHERE source_file = $1;`;
    await localDbClient.query(sql, [fileName]);

    // Delete file from disk if it exists
    const filePath = resolveUploadPath(fileName);
    if (fs.existsSync(filePath)) {
      try {
        await fs.promises.unlink(filePath);
        console.log(`[DELETE] File deleted from disk: ${filePath}`);
      } catch (fsError) {
        console.error(`[DELETE] Failed to delete file from disk:`, fsError);
        // Continue even if disk deletion fails - DB is already cleaned up
      }
    }

    return res.status(200).json({
      message: 'Document deleted successfully',
      fileName,
    });
  } catch (error) {
    console.error('Error deleting document:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /admin/knowledge-base/:fileName/rename
 * Body: { newName }
 * Renames all rows for a file
 */
exports.renameDocument = async (req, res) => {
  try {
    const { fileName } = req.params;
    const { newName } = req.body;
    if (!fileName || !newName) {
      return res
        .status(400)
        .json({ error: 'fileName and newName are required' });
    }

    // Get the old file path
    const oldFilePath = resolveUploadPath(fileName);
    const newFilePath = resolveUploadPath(newName);

    // Check if old file exists on disk
    const fileExists = fs.existsSync(oldFilePath);

    // If file exists, rename it on disk
    if (fileExists) {
      try {
        // Create directory for new file if needed
        const newFileDir = path.dirname(newFilePath);
        await fs.promises.mkdir(newFileDir, { recursive: true });
        // Rename the file
        await fs.promises.rename(oldFilePath, newFilePath);
        console.log(
          `[RENAME] File renamed on disk: ${oldFilePath} -> ${newFilePath}`,
        );
      } catch (fsError) {
        console.error(`[RENAME] Failed to rename file on disk:`, fsError);
        return res.status(500).json({ error: 'Failed to rename file on disk' });
      }
    }

    // Update database
    const sql = `UPDATE knowledge_base SET source_file = $2 WHERE source_file = $1;`;
    const result = await localDbClient.query(sql, [fileName, newName]);

    return res.status(200).json({
      message: 'Document renamed',
      oldName: fileName,
      newName,
      rowsAffected: result.rowCount,
      fileRenamed: fileExists,
    });
  } catch (error) {
    console.error('Error renaming document:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /admin/knowledge-base/:fileName/export
 * Returns aggregated text content for a file for download
 */
exports.exportDocumentText = async (req, res) => {
  try {
    const { fileName } = req.params;
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }
    const { rows } = await localDbClient.query(
      `SELECT content, (metadata->>'chunkIndex')::int AS idx
       FROM knowledge_base WHERE source_file = $1 ORDER BY idx ASC NULLS LAST, id ASC;`,
      [fileName],
    );
    const text = (rows || []).map((r) => r.content).join('\n\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName.replace(/\s+/g, '_')}.txt"`,
    );
    return res.status(200).send(text);
  } catch (error) {
    console.error('Error exporting document:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all chunks for a file
exports.getFileChunks = async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName);
    const result = await localDbClient.query(
      `SELECT id, content, source_file, metadata, created_at 
       FROM knowledge_base 
       WHERE source_file = $1 
       ORDER BY COALESCE((metadata->>'page')::int, 0), id`,
      [fileName],
    );

    const chunks = result.rows.map((row) => {
      let metadata = row.metadata || {};
      // Handle both object and string metadata
      if (typeof metadata === 'string') {
        metadata = JSON.parse(metadata);
      }

      return {
        id: row.id,
        content: row.content,
        source_file: row.source_file,
        page: metadata.page || null,
        keywords: metadata.keywords || [],
        questions: metadata.questions || [],
        tags: metadata.tags || [],
        enabled: metadata.enabled !== false,
        created_at: row.created_at,
      };
    });

    return res.status(200).json({ chunks });
  } catch (error) {
    console.error('Error fetching chunks:', error);
    return res.status(500).json({ error: 'Failed to fetch chunks' });
  }
};

// Get PDF file for viewing
exports.getFilePdf = async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName);
    const filePath = resolveUploadPath(fileName);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'PDF file not found' });
    }

    // Read and send PDF file
    const fileBuffer = await fs.promises.readFile(filePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    return res.status(200).send(fileBuffer);
  } catch (error) {
    console.error('Error serving PDF:', error);
    return res.status(500).json({ error: 'Failed to serve PDF' });
  }
};

// Update chunk (content, keywords, questions, tags, enabled)
exports.updateChunk = async (req, res) => {
  try {
    const { chunkId } = req.params;
    const { content, keywords, questions, tags, enabled } = req.body;

    // Get current chunk
    const current = await localDbClient.query(
      'SELECT metadata FROM knowledge_base WHERE id = $1',
      [chunkId],
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Chunk not found' });
    }

    let metadata = current.rows[0].metadata || {};
    // Handle both object and string metadata
    if (typeof metadata === 'string') {
      metadata = JSON.parse(metadata);
    }
    if (keywords !== undefined) metadata.keywords = keywords;
    if (questions !== undefined) metadata.questions = questions;
    if (tags !== undefined) metadata.tags = tags;
    if (enabled !== undefined) metadata.enabled = enabled;

    // Update chunk
    await localDbClient.query(
      `UPDATE knowledge_base 
       SET content = COALESCE($1, content), metadata = $2 
       WHERE id = $3`,
      [content || null, JSON.stringify(metadata), chunkId],
    );

    return res.status(200).json({ message: 'Chunk updated successfully' });
  } catch (error) {
    console.error('Error updating chunk:', error);
    return res.status(500).json({ error: 'Failed to update chunk' });
  }
};

// Delete chunk
exports.deleteChunk = async (req, res) => {
  try {
    const { chunkId } = req.params;
    await localDbClient.query('DELETE FROM knowledge_base WHERE id = $1', [
      chunkId,
    ]);
    return res.status(200).json({ message: 'Chunk deleted successfully' });
  } catch (error) {
    console.error('Error deleting chunk:', error);
    return res.status(500).json({ error: 'Failed to delete chunk' });
  }
};

// Bulk enable chunks
exports.bulkEnableChunks = async (req, res) => {
  try {
    const { chunkIds } = req.body;
    if (!chunkIds || !Array.isArray(chunkIds)) {
      return res.status(400).json({ error: 'chunkIds array is required' });
    }

    const updatePromises = chunkIds.map(async (id) => {
      const current = await localDbClient.query(
        'SELECT metadata FROM knowledge_base WHERE id = $1',
        [id],
      );
      if (current.rows.length === 0) return;
      let { metadata } = current.rows[0];
      // Handle both object and string metadata
      if (typeof metadata === 'string') {
        metadata = JSON.parse(metadata);
      } else if (!metadata) {
        metadata = {};
      }
      metadata.enabled = true;
      await localDbClient.query(
        'UPDATE knowledge_base SET metadata = $1 WHERE id = $2',
        [JSON.stringify(metadata), id],
      );
    });

    await Promise.all(updatePromises);
    return res
      .status(200)
      .json({ message: `Enabled ${chunkIds.length} chunks` });
  } catch (error) {
    console.error('Error bulk enabling chunks:', error);
    return res.status(500).json({ error: 'Failed to enable chunks' });
  }
};

// Bulk disable chunks
exports.bulkDisableChunks = async (req, res) => {
  try {
    const { chunkIds } = req.body;
    if (!chunkIds || !Array.isArray(chunkIds)) {
      return res.status(400).json({ error: 'chunkIds array is required' });
    }

    const updatePromises = chunkIds.map(async (id) => {
      const current = await localDbClient.query(
        'SELECT metadata FROM knowledge_base WHERE id = $1',
        [id],
      );
      if (current.rows.length === 0) return;
      let { metadata } = current.rows[0];
      // Handle both object and string metadata
      if (typeof metadata === 'string') {
        metadata = JSON.parse(metadata);
      } else if (!metadata) {
        metadata = {};
      }
      metadata.enabled = false;
      await localDbClient.query(
        'UPDATE knowledge_base SET metadata = $1 WHERE id = $2',
        [JSON.stringify(metadata), id],
      );
    });

    await Promise.all(updatePromises);
    return res
      .status(200)
      .json({ message: `Disabled ${chunkIds.length} chunks` });
  } catch (error) {
    console.error('Error bulk disabling chunks:', error);
    return res.status(500).json({ error: 'Failed to disable chunks' });
  }
};

// Bulk delete chunks
exports.bulkDeleteChunks = async (req, res) => {
  try {
    const { chunkIds } = req.body;
    if (!chunkIds || !Array.isArray(chunkIds)) {
      return res.status(400).json({ error: 'chunkIds array is required' });
    }

    await localDbClient.query('DELETE FROM knowledge_base WHERE id = ANY($1)', [
      chunkIds,
    ]);
    return res
      .status(200)
      .json({ message: `Deleted ${chunkIds.length} chunks` });
  } catch (error) {
    console.error('Error bulk deleting chunks:', error);
    return res.status(500).json({ error: 'Failed to delete chunks' });
  }
};
