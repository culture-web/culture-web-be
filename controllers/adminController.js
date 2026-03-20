/* eslint-disable node/no-unsupported-features/es-syntax */
/* eslint-disable node/no-unsupported-features/node-builtins */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */
/**
 * Admin Controller
 * Handles document ingestion and knowledge base updates
 */
const crypto = require('crypto');
// eslint-disable-next-line import/order
const localDbClient = require('../client/localDbClient');

/**
 * Advanced text splitter using LangChain RecursiveCharacterTextSplitter
 */
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

const clampNumber = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
};

const getChunkingConfig = (input = {}) => {
  const chunkSize = clampNumber(input.chunkSize, 100, 4000, DEFAULT_CHUNK_SIZE);
  const maxOverlap = Math.max(0, chunkSize - 1);
  const chunkOverlap = clampNumber(
    input.chunkOverlap,
    0,
    maxOverlap,
    DEFAULT_CHUNK_OVERLAP,
  );
  return { chunkSize, chunkOverlap };
};

const splitTextIntoChunks = async (text, options = {}) => {
  const { chunkSize, chunkOverlap } = getChunkingConfig(options);
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ['\n\n', '\n', '.', ' '],
  });
  const docs = await splitter.createDocuments([text]);
  return docs.map((d) => d.pageContent.trim()).filter((c) => c.length > 0);
};

// Path-traversal guard (no leading .. or absolute paths)
const validateObjectName = (name) => {
  if (!name || name.includes('..') || name.startsWith('/')) {
    throw new Error('Invalid file path');
  }
  return name;
};

const KB_OVERVIEW_BLOCKED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
]);

const isBlockedKbOverviewFile = (fileName = '') => {
  const lowerName = String(fileName || '').toLowerCase();
  return Array.from(KB_OVERVIEW_BLOCKED_EXTENSIONS).some((ext) =>
    lowerName.endsWith(ext),
  );
};

// In-memory ingest job tracker (simple, non-persistent)
const ingestJobs = new Map();
let emitIngestJobStatus = () => {};
let emitParseFileStatus = () => {};

const newJobId = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto
    .createHash('sha256')
    .update(`${Date.now()}-${crypto.randomBytes(16).toString('hex')}`)
    .digest('hex');
};

const setJobStatus = (jobId, payload) => {
  const prev = ingestJobs.get(jobId) || {};
  const next = { ...prev, ...payload, updatedAt: new Date().toISOString() };
  ingestJobs.set(jobId, next);
  emitIngestJobStatus(jobId, next);

  if (next.fileName) {
    const normalized = String(next.status || '').toLowerCase();
    let mappedStatus = 'running';
    if (normalized === 'completed') {
      mappedStatus = 'completed';
    } else if (normalized === 'failed') {
      mappedStatus = 'failed';
    }
    emitParseFileStatus(next.fileName, {
      status: mappedStatus,
      progress: next.progress,
      last_message: next.message || next.last_message,
    });
  }

  return next;
};

const ensureVersionHistoryTable = async () => {
  await localDbClient.query(`
    CREATE TABLE IF NOT EXISTS knowledge_base_versions (
      id BIGSERIAL PRIMARY KEY,
      file_name TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      action TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await localDbClient.query(`
    CREATE INDEX IF NOT EXISTS idx_kb_versions_file_time
    ON knowledge_base_versions (file_name, created_at DESC);
  `);
  await localDbClient.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_versions_file_version
    ON knowledge_base_versions (file_name, version_number);
  `);
  await localDbClient.query(`
    CREATE TABLE IF NOT EXISTS knowledge_base_version_snapshots (
      id BIGSERIAL PRIMARY KEY,
      version_id BIGINT NOT NULL REFERENCES knowledge_base_versions(id) ON DELETE CASCADE,
      chunks JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await localDbClient.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_version_snapshots_version
    ON knowledge_base_version_snapshots (version_id);
  `);
};

const getNextVersionNumber = async (fileName) => {
  const { rows } = await localDbClient.query(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
     FROM knowledge_base_versions
     WHERE file_name = $1;`,
    [fileName],
  );
  return Number(rows?.[0]?.next_version || 1);
};

const getFileChunksSnapshot = async (fileName) => {
  const { rows } = await localDbClient.query(
    `SELECT content, metadata
     FROM knowledge_base
     WHERE source_file = $1
     ORDER BY COALESCE((metadata->>'chunkIndex')::int, 999999), id ASC;`,
    [fileName],
  );
  return (rows || []).map((row) => ({
    content: row.content,
    metadata: row.metadata || {},
  }));
};

const recordFileVersion = async (
  fileName,
  action,
  metadata = {},
  options = {},
) => {
  if (!fileName) return null;
  try {
    await ensureVersionHistoryTable();
    const versionNumber = await getNextVersionNumber(fileName);
    const { rows } = await localDbClient.query(
      `INSERT INTO knowledge_base_versions (file_name, version_number, action, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, version_number;`,
      [fileName, versionNumber, action, JSON.stringify(metadata || {})],
    );

    const versionId = rows?.[0]?.id;
    if (versionId && options.captureSnapshot) {
      const chunks =
        options.snapshotChunks || (await getFileChunksSnapshot(fileName));
      await localDbClient.query(
        `INSERT INTO knowledge_base_version_snapshots (version_id, chunks)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (version_id) DO UPDATE SET chunks = EXCLUDED.chunks;`,
        [versionId, JSON.stringify(chunks || [])],
      );
    }
    return rows?.[0] || null;
  } catch (error) {
    console.error('Failed to record file version history:', error);
    return null;
  }
};

const ACTIVITY_ACTIONS = new Set([
  'parse',
  'parse_failed',
  'reembed',
  'test',
  'deploy',
]);

const ensureAdminAuditTrailTable = async () => {
  await localDbClient.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_trail (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id TEXT,
      actor_email TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await localDbClient.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_created_at
    ON admin_audit_trail (created_at DESC);
  `);
  await localDbClient.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_action
    ON admin_audit_trail (action);
  `);
  await localDbClient.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_actor
    ON admin_audit_trail (actor_user_id);
  `);
};

const getAuditLogRetentionDays = () =>
  clampNumber(process.env.AUDIT_LOG_RETENTION_DAYS, 1, 3650, 90);

const pruneAdminAuditTrail = async () => {
  const retentionDays = getAuditLogRetentionDays();
  const { rowCount } = await localDbClient.query(
    `DELETE FROM admin_audit_trail
     WHERE created_at < NOW() - ($1::int * INTERVAL '1 day');`,
    [retentionDays],
  );
  return {
    retentionDays,
    deletedRows: Number(rowCount || 0),
  };
};

const getActorFromRequest = (req) => ({
  actorUserId: req?.user?.id ? String(req.user.id) : null,
  actorEmail: req?.user?.email ? String(req.user.email) : null,
  actorRole: req?.user?.role ? String(req.user.role).toLowerCase() : null,
});

const writeAdminAuditTrail = async (
  req,
  {
    action,
    resourceType = null,
    resourceId = null,
    status = 'success',
    details = {},
  } = {},
) => {
  if (!action) return;

  try {
    await ensureAdminAuditTrailTable();
    await pruneAdminAuditTrail();
    const actor = getActorFromRequest(req);
    const safeDetails =
      details && typeof details === 'object' && !Array.isArray(details)
        ? details
        : { value: details };

    await localDbClient.query(
      `INSERT INTO admin_audit_trail (
        actor_user_id,
        actor_email,
        actor_role,
        action,
        resource_type,
        resource_id,
        status,
        details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb);`,
      [
        actor.actorUserId,
        actor.actorEmail,
        actor.actorRole,
        action,
        resourceType,
        resourceId,
        status,
        JSON.stringify(safeDetails),
      ],
    );
  } catch (error) {
    console.warn('[AUDIT] Failed to write admin audit trail:', error.message);
  }
};

const renameFileVersionHistory = async (oldName, newName) => {
  if (!oldName || !newName || oldName === newName) return;
  try {
    await ensureVersionHistoryTable();
    const { rows } = await localDbClient.query(
      `SELECT id, version_number
       FROM knowledge_base_versions
       WHERE file_name = $1
       ORDER BY version_number ASC;`,
      [oldName],
    );
    if (!rows.length) return;

    const baseVersion = await getNextVersionNumber(newName);
    for (let i = 0; i < rows.length; i += 1) {
      const item = rows[i];
      // eslint-disable-next-line no-await-in-loop
      await localDbClient.query(
        `UPDATE knowledge_base_versions
         SET file_name = $2, version_number = $3
         WHERE id = $1;`,
        [item.id, newName, baseVersion + i],
      );
    }
  } catch (error) {
    console.error('Failed to rename file version history:', error);
  }
};

// PDF parsing & OCR helpers
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const embeddingService = require('../services/embeddingService');
const storageService = require('../services/minioStorageService');
({
  emitIngestJobStatus,
  emitParseFileStatus,
} = require('../services/realtimeService'));
const groqClient = require('../client/groqClient');
const {
  ALLOWED_ROLES,
  listKbUsersFromSupabase,
  createKbUserInSupabase,
  updateKbUserRoleInSupabase,
  resetKbUserPasswordInSupabase,
} = require('../services/supabaseKbUserService');

const normalizeSummaryShape = (raw = {}) => {
  const toStringArray = (value) =>
    Array.isArray(value)
      ? value.map((item) => String(item).trim()).filter(Boolean)
      : [];

  return {
    executiveSummary: String(raw.executiveSummary || raw.summary || '').trim(),
    keyConcepts: toStringArray(raw.keyConcepts),
    topicsCovered: toStringArray(raw.topicsCovered),
    suggestedTags: toStringArray(raw.suggestedTags),
    exampleQuestions: toStringArray(raw.exampleQuestions),
  };
};

const heuristicSummaryFromChunks = (fileName, chunks) => {
  const preview = chunks
    .map((c) => c.content)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const firstSentence = preview.slice(0, 420);
  const words = preview
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4);
  const freq = new Map();
  words.forEach((w) => freq.set(w, (freq.get(w) || 0) + 1));
  const topWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);

  return {
    executiveSummary: `This document (${fileName}) appears to cover key concepts related to ${topWords.slice(0, 3).join(', ')}. It includes practical context, definitions, and usage details across sampled sections. ${firstSentence}`,
    keyConcepts: topWords.slice(0, 5),
    topicsCovered: topWords.slice(0, 5),
    suggestedTags: topWords.slice(0, 5),
    exampleQuestions: [
      'What are the core ideas in this document?',
      'How should this topic be applied in practice?',
      'What are the key terms to understand first?',
    ],
  };
};

const extractJsonObject = (text = '') => {
  const trimmed = String(text).trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // continue
  }

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      return null;
    }
  }
  return null;
};

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
const ocrPdfPages = async (buffer, options = {}) => {
  const { onProgress } = options;
  let pdfConverter;

  try {
    // eslint-disable-next-line global-require
    pdfConverter = require('pdf-img-convert');
  } catch (error) {
    throw new Error(
      'OCR dependency unavailable: install canvas/pdf-img-convert runtime dependencies',
    );
  }

  const emitProgress = (payload) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(payload || {});
    } catch (error) {
      console.warn('[OCR] Progress callback failed:', error?.message || error);
    }
  };

  try {
    console.log('[OCR] Converting PDF pages to images...');
    emitProgress({
      stage: 'converting',
      message: 'Converting PDF pages to images',
      currentPage: 0,
      totalPages: 0,
      progress: 0,
    });

    // Convert PDF pages to PNG images (returns array of buffers)
    const pngPages = await pdfConverter.convert(buffer, {
      width: 2000, // High resolution for better OCR
      height: 2000,
      page_numbers: undefined, // Convert all pages
    });

    console.log(`[OCR] Converted ${pngPages.length} pages, starting OCR...`);
    emitProgress({
      stage: 'ocr',
      message: `Converted ${pngPages.length} pages, starting OCR`,
      currentPage: 0,
      totalPages: pngPages.length,
      progress: 0,
    });

    const pageTexts = [];
    for (let i = 0; i < pngPages.length; i += 1) {
      const pngBuffer = pngPages[i];
      console.log(`[OCR] Processing page ${i + 1}/${pngPages.length}...`);
      emitProgress({
        stage: 'ocr',
        message: `OCR page ${i + 1}/${pngPages.length}: 0%`,
        currentPage: i + 1,
        totalPages: pngPages.length,
        progress: 0,
      });

      // eslint-disable-next-line no-await-in-loop
      const { data: ocr } = await Tesseract.recognize(pngBuffer, 'eng', {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            const pageProgress = Math.round((m.progress || 0) * 100);
            console.log(`[OCR] Page ${i + 1}: ${pageProgress}%`);
            emitProgress({
              stage: 'ocr',
              message: `OCR page ${i + 1}/${pngPages.length}: ${pageProgress}%`,
              currentPage: i + 1,
              totalPages: pngPages.length,
              progress: Number(m.progress || 0),
            });
          }
        },
      });

      pageTexts.push((ocr.text || '').trim());
      emitProgress({
        stage: 'ocr',
        message: `OCR page ${i + 1}/${pngPages.length}: 100%`,
        currentPage: i + 1,
        totalPages: pngPages.length,
        progress: 1,
      });
    }

    console.log('[OCR] Completed all pages');
    emitProgress({
      stage: 'ocr',
      message: 'Completed OCR for all pages',
      currentPage: pngPages.length,
      totalPages: pngPages.length,
      progress: 1,
    });
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
    const { fileName, text, metadata = {}, chunkSize, chunkOverlap } = req.body;

    if (!fileName || !text) {
      return res.status(400).json({ error: 'fileName and text are required' });
    }

    // Remove any existing parse jobs for this file since we're overwriting it
    // (status will be recalculated once new ingestion completes).
    await localDbClient.query(
      'DELETE FROM kb_jobs WHERE LOWER(file_name) = LOWER($1);',
      [fileName],
    );

    const chunkingConfig = getChunkingConfig({ chunkSize, chunkOverlap });

    // Split text into chunks (LangChain)
    const chunks = await splitTextIntoChunks(text, chunkingConfig);
    console.log(`Ingesting ${fileName} with ${chunks.length} chunk(s)`);

    // Insert each chunk with embedding
    const insertedIds = [];
    for (let i = 0; i < chunks.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await embeddingService.insertChunk(
        localDbClient,
        chunks[i],
        fileName,
        { ...metadata, chunkIndex: i, enabled: false },
      );
      insertedIds.push(result.id);
    }

    await recordFileVersion(
      fileName,
      'ingest_text',
      {
        chunksIngested: insertedIds.length,
        author: metadata.author || null,
        chunkSize: chunkingConfig.chunkSize,
        chunkOverlap: chunkingConfig.chunkOverlap,
      },
      { captureSnapshot: true },
    );

    await writeAdminAuditTrail(req, {
      action: 'kb.ingest_text',
      resourceType: 'knowledge_base_file',
      resourceId: fileName,
      details: {
        chunksIngested: insertedIds.length,
        chunkSize: chunkingConfig.chunkSize,
        chunkOverlap: chunkingConfig.chunkOverlap,
      },
    });

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
    const autoParse =
      String(req.body?.autoParse ?? 'true').toLowerCase() !== 'false';
    const rerankerStrategy = String(
      req.body?.rerankerStrategy || 'embedding-based',
    );
    const chunkingConfig = getChunkingConfig(req.body || {});
    if (!file) {
      return res.status(400).json({ error: 'No PDF uploaded' });
    }

    const jobId = newJobId();
    const fileName = file.originalname;
    const { buffer } = file;

    // Remove old parse jobs for this file, upload will create fresh state.
    await localDbClient.query(
      'DELETE FROM kb_jobs WHERE LOWER(file_name) = LOWER($1);',
      [fileName],
    );

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

    // Check if file already exists in MinIO
    const existsInStorage = await storageService.objectExists(fileName);
    if (existsInStorage) {
      return res.status(409).json({
        error:
          'A file with this name already exists in storage. Please rename your file or delete the existing one.',
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
          message: 'Saving PDF to MinIO',
        });
        await storageService.putObject(fileName, buffer, 'application/pdf');
        console.log(`[INGEST PDF] File persisted to MinIO: ${fileName}`);

        if (!autoParse) {
          setJobStatus(jobId, {
            status: 'completed',
            progress: 100,
            message: 'PDF uploaded (awaiting parse)',
            fileName,
            chunksIngested: 0,
            pagesProcessed: 0,
          });
          await recordFileVersion(
            fileName,
            'upload_pdf',
            {
              chunksIngested: 0,
              pagesProcessed: 0,
              autoParse: false,
              rerankerStrategy,
              chunkSize: chunkingConfig.chunkSize,
              chunkOverlap: chunkingConfig.chunkOverlap,
            },
            { captureSnapshot: false },
          );
          return;
        }

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
            message: 'Initializing OCR (may take a while)',
          });
          pageTexts = await ocrPdfPages(buffer, {
            onProgress: ({
              stage,
              message,
              currentPage,
              totalPages,
              progress,
            }) => {
              const pages = Math.max(1, Number(totalPages || 1));
              const pageIndex = Math.max(0, Number(currentPage || 0));
              const pageProgress = Math.max(
                0,
                Math.min(1, Number(progress || 0)),
              );

              if (stage === 'converting') {
                setJobStatus(jobId, {
                  status: 'ocr',
                  progress: 30,
                  message: message || 'Converting PDF pages to images',
                });
                return;
              }

              const ocrOverall =
                (Math.max(0, pageIndex - 1) + pageProgress) / pages;
              const mappedProgress = Math.round(30 + ocrOverall * 40); // 30-70
              setJobStatus(jobId, {
                status: 'ocr',
                progress: Math.max(30, Math.min(70, mappedProgress)),
                message:
                  message ||
                  `OCR page ${Math.max(1, Math.min(pageIndex, pages))}/${pages}: ${Math.round(pageProgress * 100)}%`,
              });
            },
          });
        } else {
          pageTexts = [extracted];
        }

        const insertedIds = [];
        const totalPages = pageTexts.length || 1;
        const chunkingBase = !extracted || extracted.length < 50 ? 70 : 40;
        const chunkingRange = !extracted || extracted.length < 50 ? 20 : 50;
        for (let p = 0; p < pageTexts.length; p += 1) {
          const pageText = pageTexts[p];
          if (pageText && pageText.trim().length > 0) {
            // eslint-disable-next-line no-await-in-loop
            const chunks = await splitTextIntoChunks(pageText, chunkingConfig);
            for (let i = 0; i < chunks.length; i += 1) {
              // eslint-disable-next-line no-await-in-loop
              const result = await embeddingService.insertChunk(
                localDbClient,
                chunks[i],
                fileName,
                {
                  page: p + 1,
                  chunkIndex: i,
                  chunkNumber: i + 1,
                  rerankerStrategy,
                  chunkSize: chunkingConfig.chunkSize,
                  chunkOverlap: chunkingConfig.chunkOverlap,
                  enabled: false,
                },
              );
              insertedIds.push(result.id);
            }
          }
          const pageProgress =
            chunkingBase +
            Math.min(
              chunkingRange,
              Math.floor(((p + 1) / totalPages) * chunkingRange),
            );
          setJobStatus(jobId, {
            status: 'embedding',
            progress: Math.min(95, pageProgress),
            message: `Embedding page ${p + 1}/${totalPages}`,
          });
        }

        setJobStatus(jobId, {
          status: 'embedding',
          progress: 95,
          message: 'Finalizing parse',
        });

        setJobStatus(jobId, {
          status: 'completed',
          progress: 100,
          message: 'PDF ingested',
          fileName,
          chunksIngested: insertedIds.length,
          pagesProcessed: pageTexts.length,
        });

        await recordFileVersion(
          fileName,
          'ingest_pdf',
          {
            chunksIngested: insertedIds.length,
            pagesProcessed: pageTexts.length,
            rerankerStrategy,
            chunkSize: chunkingConfig.chunkSize,
            chunkOverlap: chunkingConfig.chunkOverlap,
          },
          { captureSnapshot: true },
        );
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
    const allObjects = await storageService.listObjects('');

    // Process rows to extract enabled status from metadata
    const processedRows = rows
      .map((row) => {
        let enabled = true; // Default to true if no metadata
        const targets = new Set();

        // Check if any chunk has enabled explicitly set to false
        if (row.all_metadata && Array.isArray(row.all_metadata)) {
          for (const meta of row.all_metadata) {
            if (meta && typeof meta === 'object' && meta.enabled === false) {
              enabled = false;
            }
            if (
              meta &&
              typeof meta === 'object' &&
              Array.isArray(meta.deployTargets)
            ) {
              meta.deployTargets
                .map((target) =>
                  String(target || '')
                    .trim()
                    .toLowerCase(),
                )
                .filter(Boolean)
                .forEach((target) => targets.add(target));
            }
            if (
              meta &&
              typeof meta === 'object' &&
              typeof meta.deployTarget === 'string' &&
              meta.deployTarget.trim()
            ) {
              targets.add(meta.deployTarget.trim().toLowerCase());
            }
          }
        }

        let deployTarget = 'shared';
        if (targets.size === 1) {
          const [singleTarget] = Array.from(targets);
          deployTarget = singleTarget;
        } else if (targets.size > 1) {
          deployTarget = 'mixed';
        }

        return {
          name: row.name,
          upload_date: row.upload_date,
          chunk_number: row.chunk_number,
          enabled,
          deploy_target: deployTarget,
          deploy_targets: Array.from(targets),
        };
      })
      .filter((row) => !isBlockedKbOverviewFile(row.name));

    const existingNames = new Set(processedRows.map((row) => row.name));
    const stagedRows = allObjects
      .filter((obj) => !!obj?.name)
      .filter((obj) => !obj.name.endsWith('/.keep'))
      .filter((obj) => !existingNames.has(obj.name))
      .filter((obj) => !isBlockedKbOverviewFile(obj.name))
      .map((obj) => ({
        name: obj.name,
        upload_date: obj.lastModified || new Date().toISOString(),
        chunk_number: 0,
        enabled: false,
        deploy_target: 'shared',
        deploy_targets: [],
      }));

    const combinedRows = [...processedRows, ...stagedRows].sort(
      (a, b) =>
        new Date(b.upload_date).getTime() - new Date(a.upload_date).getTime(),
    );

    return res.status(200).json(combinedRows || []);
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

    // From MinIO (virtual folders)
    const minioFolders = await storageService.listFolders();
    minioFolders.forEach((f) => folderSet.add(f));

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
    validateObjectName(safeName);

    // Check if folder already exists in MinIO or DB
    const exists = await storageService.folderExists(safeName);
    if (exists) {
      return res
        .status(409)
        .json({ error: 'Folder with this name already exists' });
    }

    await storageService.createFolder(safeName);
    await writeAdminAuditTrail(req, {
      action: 'kb.folder.create',
      resourceType: 'folder',
      resourceId: safeName,
    });
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

    // Delete all objects under this prefix from MinIO
    let storageDeleted = 0;
    try {
      storageDeleted = await storageService.removeObjectsByPrefix(
        `${folderName}/`,
      );
    } catch (storageError) {
      console.error('Failed to delete folder from MinIO:', storageError);
    }

    await writeAdminAuditTrail(req, {
      action: 'kb.folder.delete',
      resourceType: 'folder',
      resourceId: folderName,
      details: {
        rowsDeleted: dbResult.rowCount,
        storageObjectsDeleted: storageDeleted,
      },
    });

    return res.status(200).json({
      message: 'Folder deleted',
      folderName,
      rowsDeleted: dbResult.rowCount,
      storageObjectsDeleted: storageDeleted,
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
 * GET /admin/audit-trail
 * Query params: limit, offset, action, resourceType, actorUserId, status, search
 */
exports.getAuditTrail = async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can view audit trail' });
    }

    await ensureAdminAuditTrailTable();
    const pruneResult = await pruneAdminAuditTrail();

    const limit = clampNumber(req.query?.limit, 1, 200, 50);
    const offset = clampNumber(req.query?.offset, 0, 100000, 0);
    const action = req.query?.action ? String(req.query.action).trim() : null;
    const resourceType = req.query?.resourceType
      ? String(req.query.resourceType).trim()
      : null;
    const actorUserId = req.query?.actorUserId
      ? String(req.query.actorUserId).trim()
      : null;
    const status = req.query?.status ? String(req.query.status).trim() : null;
    const search = req.query?.search ? String(req.query.search).trim() : null;

    const conditions = [];
    const params = [];

    if (action) {
      params.push(action);
      conditions.push(`action = $${params.length}`);
    }
    if (resourceType) {
      params.push(resourceType);
      conditions.push(`resource_type = $${params.length}`);
    }
    if (actorUserId) {
      params.push(actorUserId);
      conditions.push(`actor_user_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(
        action ILIKE $${params.length}
        OR resource_type ILIKE $${params.length}
        OR resource_id ILIKE $${params.length}
        OR actor_email ILIKE $${params.length}
      )`);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const countSql = `SELECT COUNT(*)::int AS total FROM admin_audit_trail ${whereClause};`;
    const { rows: countRows } = await localDbClient.query(countSql, params);
    const total = Number(countRows?.[0]?.total || 0);

    const listParams = [...params, limit, offset];
    const listSql = `
      SELECT
        id,
        actor_user_id,
        actor_email,
        actor_role,
        action,
        resource_type,
        resource_id,
        status,
        details,
        created_at
      FROM admin_audit_trail
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2};
    `;
    const { rows } = await localDbClient.query(listSql, listParams);

    return res.status(200).json({
      total,
      limit,
      offset,
      retentionDays: pruneResult.retentionDays,
      prunedRows: pruneResult.deletedRows,
      entries: rows || [],
    });
  } catch (error) {
    console.error('Error fetching audit trail:', error);
    return res.status(500).json({ error: 'Failed to fetch audit trail' });
  }
};

/**
 * POST /admin/knowledge-base/:fileName/enable
 * Body: { enabled: boolean }
 * Sets enabled flag for all chunks of a file
 */
exports.setFileEnabled = async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName || '');
    const { enabled, deployTarget } = req.body;
    const normalizedDeployTarget =
      typeof deployTarget === 'string' && deployTarget.trim().length > 0
        ? deployTarget.trim().toLowerCase()
        : null;
    const allowedTargets = new Set(['mudras', 'kathakali', 'shared']);
    if (!fileName || typeof enabled === 'undefined') {
      return res
        .status(400)
        .json({ error: 'fileName and enabled are required' });
    }
    if (
      enabled &&
      normalizedDeployTarget &&
      !allowedTargets.has(normalizedDeployTarget)
    ) {
      return res.status(400).json({
        error: 'deployTarget must be one of mudras, kathakali, shared',
      });
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
      if (enabled) {
        const targetSet = new Set();
        if (Array.isArray(metadata.deployTargets)) {
          metadata.deployTargets
            .map((target) =>
              String(target || '')
                .trim()
                .toLowerCase(),
            )
            .filter(Boolean)
            .forEach((target) => targetSet.add(target));
        }
        if (
          typeof metadata.deployTarget === 'string' &&
          metadata.deployTarget.trim()
        ) {
          targetSet.add(metadata.deployTarget.trim().toLowerCase());
        }
        if (normalizedDeployTarget) {
          targetSet.add(normalizedDeployTarget);
        }
        metadata.deployTargets = Array.from(targetSet);
        metadata.deployTarget = metadata.deployTargets[0] || null;
      } else {
        metadata.deployTargets = [];
        metadata.deployTarget = null;
      }
      await localDbClient.query(
        'UPDATE knowledge_base SET metadata = $1 WHERE id = $2',
        [JSON.stringify(metadata), row.id],
      );
    });

    await Promise.all(updatePromises);
    await recordFileVersion(
      fileName,
      'set_enabled',
      {
        enabled: Boolean(enabled),
        deployTarget: enabled ? normalizedDeployTarget || null : null,
        mode: enabled ? 'add_target' : 'disable_all',
      },
      { captureSnapshot: true },
    );

    await writeAdminAuditTrail(req, {
      action: enabled ? 'kb.file.enable' : 'kb.file.disable',
      resourceType: 'knowledge_base_file',
      resourceId: fileName,
      details: {
        enabled: Boolean(enabled),
        deployTarget: enabled ? normalizedDeployTarget || null : null,
      },
    });

    const refreshedChunks = await localDbClient.query(
      'SELECT metadata FROM knowledge_base WHERE source_file = $1',
      [fileName],
    );
    const deployTargetsSet = new Set();
    (refreshedChunks.rows || []).forEach((row) => {
      const metadata = row.metadata || {};
      if (Array.isArray(metadata.deployTargets)) {
        metadata.deployTargets
          .map((target) =>
            String(target || '')
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean)
          .forEach((target) => deployTargetsSet.add(target));
      }
      if (
        typeof metadata.deployTarget === 'string' &&
        metadata.deployTarget.trim()
      ) {
        deployTargetsSet.add(metadata.deployTarget.trim().toLowerCase());
      }
    });

    return res.status(200).json({
      message: 'File enabled state updated',
      fileName,
      enabled,
      deployTarget: enabled ? normalizedDeployTarget || null : null,
      deployTargets: Array.from(deployTargetsSet),
    });
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
    const fileName = decodeURIComponent(req.params.fileName || '');
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

    await recordFileVersion(
      fileName,
      'reembed',
      { chunksUpdated: updated },
      { captureSnapshot: true },
    );

    await writeAdminAuditTrail(req, {
      action: 'kb.file.reembed',
      resourceType: 'knowledge_base_file',
      resourceId: fileName,
      details: { chunksUpdated: updated },
    });

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
    const fileName = decodeURIComponent(req.params.fileName || '');
    const chunkingConfig = getChunkingConfig(req.body || {});
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    if (isBlockedKbOverviewFile(fileName)) {
      return res.status(400).json({
        error: 'This file type is not supported for KB parsing',
      });
    }

    const { rows: activeRows } = await localDbClient.query(
      `SELECT id, status, progress, start_time
       FROM kb_jobs
       WHERE file_name = $1
         AND status IN ('queued', 'running')
         AND end_time IS NULL
       ORDER BY start_time DESC
       LIMIT 1;`,
      [fileName],
    );
    if (activeRows.length > 0) {
      const activeJob = activeRows[0];
      return res.status(409).json({
        error: 'Parse already in progress for this file',
        fileName,
        activeJob,
      });
    }

    // Create job row
    const { rows: jobRows } = await localDbClient.query(
      `INSERT INTO kb_jobs (file_name, status, progress, start_time, last_message)
       VALUES ($1, 'running', 0, NOW(), 'Starting parse')
       RETURNING id;`,
      [fileName],
    );
    const jobId = jobRows[0].id;
    emitParseFileStatus(fileName, {
      id: jobId,
      file_name: fileName,
      status: 'running',
      progress: 0,
      last_message: 'Starting parse',
      start_time: new Date().toISOString(),
    });

    // Run job asynchronously (fire-and-forget)
    (async () => {
      try {
        const { rows } = await localDbClient.query(
          'SELECT id, content FROM knowledge_base WHERE source_file = $1 ORDER BY id ASC;',
          [fileName],
        );
        let updated = 0;

        if (rows.length === 0) {
          const existsInStorage = await storageService.objectExists(fileName);
          if (!existsInStorage) {
            throw new Error('File not found in knowledge base or storage');
          }

          await localDbClient.query(
            `UPDATE kb_jobs SET progress = $2, last_message = $3 WHERE id = $1;`,
            [jobId, 10, 'Loading file from storage'],
          );
          emitParseFileStatus(fileName, {
            id: jobId,
            file_name: fileName,
            status: 'running',
            progress: 10,
            last_message: 'Loading file from storage',
          });

          const fileBuffer = await storageService.getObject(fileName);
          let pageTexts = [];
          const lowerName = String(fileName || '').toLowerCase();
          let usedOcr = false;

          if (lowerName.endsWith('.pdf')) {
            await localDbClient.query(
              `UPDATE kb_jobs SET progress = $2, last_message = $3 WHERE id = $1;`,
              [jobId, 20, 'Extracting PDF text'],
            );
            emitParseFileStatus(fileName, {
              id: jobId,
              file_name: fileName,
              status: 'running',
              progress: 20,
              last_message: 'Extracting PDF text',
            });
            const extracted = await extractTextWithPdfParse(fileBuffer);
            if (!extracted || extracted.length < 50) {
              usedOcr = true;
              await localDbClient.query(
                `UPDATE kb_jobs SET progress = $2, last_message = $3 WHERE id = $1;`,
                [jobId, 35, 'Running OCR'],
              );
              emitParseFileStatus(fileName, {
                id: jobId,
                file_name: fileName,
                status: 'running',
                progress: 35,
                last_message: 'Running OCR',
              });
              pageTexts = await ocrPdfPages(fileBuffer, {
                onProgress: async ({
                  stage,
                  message,
                  currentPage,
                  totalPages,
                  progress,
                }) => {
                  const pages = Math.max(1, Number(totalPages || 1));
                  const pageIndex = Math.max(0, Number(currentPage || 0));
                  const pageProgress = Math.max(
                    0,
                    Math.min(1, Number(progress || 0)),
                  );

                  if (stage === 'converting') {
                    await localDbClient.query(
                      `UPDATE kb_jobs SET progress = $2, last_message = $3 WHERE id = $1;`,
                      [jobId, 35, message || 'Converting PDF pages to images'],
                    );
                    emitParseFileStatus(fileName, {
                      id: jobId,
                      file_name: fileName,
                      status: 'running',
                      progress: 35,
                      last_message: message || 'Converting PDF pages to images',
                    });
                    return;
                  }

                  const ocrOverall =
                    (Math.max(0, pageIndex - 1) + pageProgress) / pages;
                  const mappedProgress = Math.round(35 + ocrOverall * 40); // 35-75
                  await localDbClient.query(
                    `UPDATE kb_jobs SET progress = $2, last_message = $3 WHERE id = $1;`,
                    [
                      jobId,
                      Math.max(35, Math.min(75, mappedProgress)),
                      message ||
                        `OCR page ${Math.max(1, Math.min(pageIndex, pages))}/${pages}: ${Math.round(pageProgress * 100)}%`,
                    ],
                  );
                  emitParseFileStatus(fileName, {
                    id: jobId,
                    file_name: fileName,
                    status: 'running',
                    progress: Math.max(35, Math.min(75, mappedProgress)),
                    last_message:
                      message ||
                      `OCR page ${Math.max(1, Math.min(pageIndex, pages))}/${pages}: ${Math.round(pageProgress * 100)}%`,
                  });
                },
              });
            } else {
              pageTexts = [extracted];
            }
          } else {
            pageTexts = [fileBuffer.toString('utf8')];
          }

          const totalPages = Math.max(1, pageTexts.length);
          const chunkingBase = usedOcr ? 75 : 45;
          const chunkingRange = usedOcr ? 20 : 50;
          for (let p = 0; p < pageTexts.length; p += 1) {
            const pageText = pageTexts[p];
            if (pageText && pageText.trim()) {
              const chunks = await splitTextIntoChunks(
                pageText,
                chunkingConfig,
              );
              for (let i = 0; i < chunks.length; i += 1) {
                const result = await embeddingService.insertChunk(
                  localDbClient,
                  chunks[i],
                  fileName,
                  {
                    page: p + 1,
                    chunkIndex: i,
                    chunkNumber: i + 1,
                    chunkSize: chunkingConfig.chunkSize,
                    chunkOverlap: chunkingConfig.chunkOverlap,
                    enabled: false,
                  },
                );
                if (result?.id) updated += 1;
              }
            }

            const progress = Math.min(
              95,
              chunkingBase + Math.floor(((p + 1) / totalPages) * chunkingRange),
            );
            await localDbClient.query(
              `UPDATE kb_jobs SET progress = $2, last_message = $3 WHERE id = $1;`,
              [jobId, progress, `Processed page ${p + 1}/${totalPages}`],
            );
            emitParseFileStatus(fileName, {
              id: jobId,
              file_name: fileName,
              status: 'running',
              progress,
              last_message: `Processed page ${p + 1}/${totalPages}`,
            });
          }
        } else {
          const total = rows.length || 1;
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
            emitParseFileStatus(fileName, {
              id: jobId,
              file_name: fileName,
              status: 'running',
              progress,
              last_message: `Updated ${updated}/${total} chunks`,
            });
          }
        }
        await localDbClient.query(
          `UPDATE kb_jobs SET status = 'completed', progress = 100, end_time = NOW(), last_message = 'Completed' WHERE id = $1;`,
          [jobId],
        );
        emitParseFileStatus(fileName, {
          id: jobId,
          file_name: fileName,
          status: 'completed',
          progress: 100,
          last_message: 'Completed',
          end_time: new Date().toISOString(),
        });
        await recordFileVersion(
          fileName,
          'parse',
          {
            chunksUpdated: updated,
            chunkSize: chunkingConfig.chunkSize,
            chunkOverlap: chunkingConfig.chunkOverlap,
          },
          { captureSnapshot: true },
        );
        await writeAdminAuditTrail(req, {
          action: 'kb.file.parse.complete',
          resourceType: 'knowledge_base_file',
          resourceId: fileName,
          details: {
            chunksUpdated: updated,
            chunkSize: chunkingConfig.chunkSize,
            chunkOverlap: chunkingConfig.chunkOverlap,
          },
        });
      } catch (e) {
        await localDbClient.query(
          `UPDATE kb_jobs SET status = 'failed', end_time = NOW(), last_message = $2 WHERE id = $1;`,
          [jobId, e.message || 'Failed'],
        );
        emitParseFileStatus(fileName, {
          id: jobId,
          file_name: fileName,
          status: 'failed',
          progress: 100,
          last_message: e.message || 'Failed',
          end_time: new Date().toISOString(),
        });
        await recordFileVersion(fileName, 'parse_failed', {
          reason: e.message || 'Failed',
        });
        await writeAdminAuditTrail(req, {
          action: 'kb.file.parse.failed',
          resourceType: 'knowledge_base_file',
          resourceId: fileName,
          status: 'failed',
          details: {
            reason: e.message || 'Failed',
          },
        });
      }
    })();

    await writeAdminAuditTrail(req, {
      action: 'kb.file.parse.start',
      resourceType: 'knowledge_base_file',
      resourceId: fileName,
      details: {
        jobId,
        chunkSize: chunkingConfig.chunkSize,
        chunkOverlap: chunkingConfig.chunkOverlap,
      },
    });

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
    const fileName = decodeURIComponent(req.params.fileName || '');
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    const { rows } = await localDbClient.query(
      `SELECT id, file_name, status, progress, start_time, end_time, last_message
       FROM kb_jobs WHERE file_name = $1 ORDER BY start_time DESC LIMIT 1;`,
      [fileName],
    );
    if (rows && rows.length > 0) {
      return res.status(200).json(rows[0]);
    }

    const { rows: chunkRows } = await localDbClient.query(
      'SELECT COUNT(*)::int AS chunk_count FROM knowledge_base WHERE source_file = $1;',
      [fileName],
    );
    const chunkCount = Number(chunkRows?.[0]?.chunk_count || 0);

    if (chunkCount === 0) {
      return res
        .status(200)
        .json({ status: 'idle', progress: 0, last_message: 'Not parsed yet' });
    }

    return res
      .status(200)
      .json({ status: 'completed', progress: 100, last_message: 'Completed' });
  } catch (error) {
    console.error('Error getting job status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// -----------------------------------------------------------------------------
// Administrative helpers
// -----------------------------------------------------------------------------

/**
 * DELETE /admin/jobs
 * Remove all job records from the database.  Useful when old/inconsistent jobs
 * are polluting the system or during cleanup prior to rerunning ingestion.
 * Requires an admin role.
 */
exports.clearJobs = async (req, res) => {
  try {
    const result = await localDbClient.query('DELETE FROM kb_jobs;');
    console.log(`[JOBS] Cleared ${result.rowCount} job record(s)`);
    return res.json({ deleted: result.rowCount });
  } catch (error) {
    console.error('Error clearing jobs:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * DELETE /admin/knowledge-base/:fileName
 * Delete all chunks for a specific file
 */
exports.deleteDocument = async (req, res) => {
  try {
    let fileName = decodeURIComponent(req.params.fileName || '');
    fileName = String(fileName).trim();

    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    // use case-insensitive matching to avoid problems with encoding/case
    const preDeleteInfo = await localDbClient.query(
      `SELECT COUNT(*)::int AS chunk_count, MIN(created_at) AS first_uploaded_at
       FROM knowledge_base
       WHERE LOWER(source_file) = LOWER($1);`,
      [fileName],
    );
    const chunkCount = Number(preDeleteInfo.rows?.[0]?.chunk_count || 0);
    const preDeleteChunks = await getFileChunksSnapshot(fileName);

    // Delete from database (case-insensitive)
    const sql = `DELETE FROM knowledge_base WHERE LOWER(source_file) = LOWER($1);`;
    const result = await localDbClient.query(sql, [fileName]);

    await localDbClient.query(
      'DELETE FROM kb_jobs WHERE LOWER(file_name) = LOWER($1);',
      [fileName],
    );

    if (result.rowCount === 0) {
      console.warn(`[DELETE] No rows found for source_file: ${fileName}`);
      return res.status(404).json({
        error: 'Document not found in database',
        fileName,
      });
    }

    console.log(`[DELETE] Deleted ${result.rowCount} row(s) for: ${fileName}`);

    // Delete file from MinIO if it exists
    try {
      const existsInStorage = await storageService.objectExists(fileName);
      if (existsInStorage) {
        await storageService.removeObject(fileName);
        console.log(`[DELETE] File deleted from MinIO: ${fileName}`);
      }
    } catch (storageError) {
      console.error(`[DELETE] Failed to delete file from MinIO:`, storageError);
      // Continue even if storage deletion fails - DB is already cleaned up
    }

    await recordFileVersion(
      fileName,
      'delete',
      {
        rowsDeleted: result.rowCount,
        chunkCountBeforeDelete: chunkCount,
      },
      { captureSnapshot: true, snapshotChunks: preDeleteChunks },
    );

    await writeAdminAuditTrail(req, {
      action: 'kb.file.delete',
      resourceType: 'knowledge_base_file',
      resourceId: fileName,
      details: {
        rowsDeleted: result.rowCount,
        chunkCountBeforeDelete: chunkCount,
      },
    });

    return res.status(200).json({
      message: 'Document deleted successfully',
      fileName,
      rowsDeleted: result.rowCount,
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
    const fileName = decodeURIComponent(req.params.fileName || '');
    const { newName } = req.body;
    if (!fileName || !newName) {
      return res
        .status(400)
        .json({ error: 'fileName and newName are required' });
    }

    validateObjectName(newName);

    // Check if old file exists in MinIO
    const fileExists = await storageService.objectExists(fileName);

    // If file exists, rename it in MinIO (copy + delete)
    if (fileExists) {
      try {
        await storageService.renameObject(fileName, newName);
        console.log(
          `[RENAME] File renamed in MinIO: ${fileName} -> ${newName}`,
        );
      } catch (storageError) {
        console.error(`[RENAME] Failed to rename file in MinIO:`, storageError);
        return res
          .status(500)
          .json({ error: 'Failed to rename file in storage' });
      }
    }

    // Update database
    const sql = `UPDATE knowledge_base SET source_file = $2 WHERE source_file = $1;`;
    const result = await localDbClient.query(sql, [fileName, newName]);

    await renameFileVersionHistory(fileName, newName);
    await recordFileVersion(
      newName,
      'rename',
      {
        oldName: fileName,
        newName,
        rowsAffected: result.rowCount,
        fileRenamed: fileExists,
      },
      { captureSnapshot: true },
    );

    await writeAdminAuditTrail(req, {
      action: 'kb.file.rename',
      resourceType: 'knowledge_base_file',
      resourceId: newName,
      details: {
        oldName: fileName,
        newName,
        rowsAffected: result.rowCount,
      },
    });

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
    const fileName = decodeURIComponent(req.params.fileName || '');
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

/**
 * GET /admin/knowledge-base/:fileName/summary
 * Smart sample chunks (first 2, last 1, random 1) and generate AI summary metadata
 */
exports.getDocumentSummary = async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName || '');
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    const { rows } = await localDbClient.query(
      `SELECT id, content, metadata
       FROM knowledge_base
       WHERE source_file = $1
       ORDER BY COALESCE((metadata->>'chunkIndex')::int, 999999), id ASC;`,
      [fileName],
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'No chunks found for file' });
    }

    const selected = [];
    const usedIds = new Set();
    const addChunk = (chunk) => {
      if (!chunk || usedIds.has(chunk.id)) return;
      usedIds.add(chunk.id);
      selected.push(chunk);
    };

    addChunk(rows[0]);
    addChunk(rows[1]);
    addChunk(rows[rows.length - 1]);

    const remaining = rows.filter((row) => !usedIds.has(row.id));
    if (remaining.length > 0) {
      const randomChunk =
        remaining[Math.floor(Math.random() * remaining.length)];
      addChunk(randomChunk);
    }

    const sampledContext = selected
      .map((chunk, index) => {
        const page = chunk.metadata?.page
          ? ` (page ${chunk.metadata.page})`
          : '';
        return `Sample ${index + 1} [chunk:${chunk.id}]${page}:\n${String(chunk.content || '').slice(0, 1200)}`;
      })
      .join('\n\n');

    let summary = null;

    try {
      const client = groqClient.getInstance();
      const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          {
            role: 'system',
            content:
              'You summarize knowledge-base files for administrators. Return ONLY valid JSON with keys: executiveSummary, keyConcepts, topicsCovered, suggestedTags, exampleQuestions. executiveSummary must be 2-5 sentences.',
          },
          {
            role: 'user',
            content: `File: ${fileName}\n\nUsing these sampled chunks, produce a concise admin-oriented summary.\n\n${sampledContext}`,
          },
        ],
      });

      const content = completion?.choices?.[0]?.message?.content || '';
      const parsed = extractJsonObject(content);
      if (parsed) {
        summary = normalizeSummaryShape(parsed);
      }
    } catch (llmError) {
      console.error(
        '[SUMMARY] LLM summary generation failed:',
        llmError.message,
      );
    }

    if (!summary || !summary.executiveSummary) {
      summary = heuristicSummaryFromChunks(fileName, selected);
    }

    return res.status(200).json({
      fileName,
      chunkCount: rows.length,
      sampledChunkIds: selected.map((chunk) => chunk.id),
      samplingStrategy: 'first2_last1_random1',
      summary,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error generating document summary:', error);
    return res
      .status(500)
      .json({ error: 'Failed to generate document summary' });
  }
};

/**
 * GET /admin/knowledge-base/:fileName/activity
 * Returns parse/test/deploy/reparse activity history for a specific file
 */
exports.getFileActivityHistory = async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName || '');
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    await ensureVersionHistoryTable();
    const { rows } = await localDbClient.query(
      `SELECT v.id, v.file_name, v.action, v.metadata, v.created_at
       FROM knowledge_base_versions v
       WHERE file_name = $1
         AND v.action = ANY($2::text[])
       ORDER BY created_at DESC;`,
      [fileName, Array.from(ACTIVITY_ACTIONS)],
    );

    return res.status(200).json({
      fileName,
      activities: rows || [],
    });
  } catch (error) {
    console.error('Error fetching file activity history:', error);
    return res
      .status(500)
      .json({ error: 'Failed to fetch file activity history' });
  }
};

/**
 * POST /admin/knowledge-base/:fileName/activity
 * Body: { action: 'test' | 'deploy' | 'parse' | 'reparse', metadata?: object }
 */
exports.logFileActivity = async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName || '');
    const actionInput = String(req.body?.action || '').toLowerCase();
    const action = actionInput === 'reparse' ? 'reembed' : actionInput;
    const metadata =
      req.body?.metadata && typeof req.body.metadata === 'object'
        ? req.body.metadata
        : {};

    if (!fileName || !ACTIVITY_ACTIONS.has(action)) {
      return res.status(400).json({
        error:
          'Valid fileName and action are required (parse, reparse, test, deploy)',
      });
    }

    const saved = await recordFileVersion(fileName, action, metadata, {
      captureSnapshot: false,
    });

    await writeAdminAuditTrail(req, {
      action: `kb.activity.${action}`,
      resourceType: 'knowledge_base_file',
      resourceId: fileName,
      details: metadata,
    });

    return res.status(200).json({
      message: 'Activity recorded',
      fileName,
      action,
      activityId: saved?.id || null,
    });
  } catch (error) {
    console.error('Error recording file activity:', error);
    return res.status(500).json({ error: 'Failed to record file activity' });
  }
};

// Get PDF file for viewing
exports.getFilePdf = async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName);
    validateObjectName(fileName);

    // Check if file exists in MinIO
    const exists = await storageService.objectExists(fileName);
    if (!exists) {
      return res.status(404).json({ error: 'PDF file not found' });
    }

    // Read and send PDF file from MinIO
    const fileBuffer = await storageService.getObject(fileName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    return res.status(200).send(fileBuffer);
  } catch (error) {
    console.error('Error serving PDF:', error);
    return res.status(500).json({ error: 'Failed to serve PDF' });
  }
};

// Download file from MinIO storage (force download instead of inline display)
exports.downloadFile = async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName);
    validateObjectName(fileName);

    // Check if file exists in MinIO
    const exists = await storageService.objectExists(fileName);
    if (!exists) {
      return res.status(404).json({ error: 'File not found in storage' });
    }

    // Read file from MinIO
    const fileBuffer = await storageService.getObject(fileName);

    // Determine content type based on file extension
    let contentType = 'application/octet-stream';
    if (fileName.toLowerCase().endsWith('.pdf')) {
      contentType = 'application/pdf';
    } else if (fileName.toLowerCase().endsWith('.txt')) {
      contentType = 'text/plain';
    } else if (fileName.toLowerCase().endsWith('.json')) {
      contentType = 'application/json';
    }

    // Extract just the filename (remove path if present)
    const basename = fileName.split('/').pop() || fileName;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${basename}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    return res.status(200).send(fileBuffer);
  } catch (error) {
    console.error('Error downloading file:', error);
    return res.status(500).json({ error: 'Failed to download file' });
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

// List application users for admin management
exports.listUsers = async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can manage KB users' });
    }
    const users = await listKbUsersFromSupabase();
    return res.status(200).json({ users });
  } catch (error) {
    console.error('Error listing users:', error);
    return res.status(500).json({ error: 'Failed to list users' });
  }
};

// Create a new application user
exports.createUser = async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can manage KB users' });
    }

    const { username, email, password, role } = req.body;

    if (!username || !email || !password || !role) {
      return res.status(400).json({
        error: 'username, email, password and role are required',
      });
    }
    if (!ALLOWED_ROLES.has(String(role).trim().toLowerCase())) {
      return res.status(400).json({
        error: 'role must be one of: admin, editor, viewer',
      });
    }

    try {
      const user = await createKbUserInSupabase({
        username,
        email,
        password,
        role,
      });
      await writeAdminAuditTrail(req, {
        action: 'user.create',
        resourceType: 'user',
        resourceId: user?.id || user?.email || email,
        details: {
          username,
          email,
          role,
        },
      });
      return res.status(201).json({
        message: 'User created successfully',
        user,
      });
    } catch (error) {
      const errorMessage = String(error.message || '').toLowerCase();
      if (
        errorMessage.includes('duplicate key') ||
        errorMessage.includes('already exists') ||
        errorMessage.includes('already registered')
      ) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      throw error;
    }
  } catch (error) {
    console.error('Error creating user:', error);
    return res.status(500).json({ error: 'Failed to create user' });
  }
};

// Update role for an existing user
exports.updateUserRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can manage KB users' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!role) {
      return res.status(400).json({ error: 'role is required' });
    }

    if (!ALLOWED_ROLES.has(String(role).trim().toLowerCase())) {
      return res
        .status(400)
        .json({ error: 'role must be one of: admin, editor, viewer' });
    }

    const user = await updateKbUserRoleInSupabase(userId, role);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await writeAdminAuditTrail(req, {
      action: 'user.role.update',
      resourceType: 'user',
      resourceId: userId,
      details: {
        role,
      },
    });

    return res.status(200).json({
      message: 'User role updated successfully',
      user,
    });
  } catch (error) {
    console.error('Error updating user role:', error);
    return res.status(500).json({ error: 'Failed to update user role' });
  }
};

// Reset password for user (admin action)
exports.resetUserPassword = async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can reset passwords' });
    }

    const { userId } = req.params;
    const { newPassword } = req.body;

    if (!userId || !newPassword) {
      return res
        .status(400)
        .json({ error: 'userId and newPassword are required' });
    }

    const user = await resetKbUserPasswordInSupabase(userId, newPassword);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await writeAdminAuditTrail(req, {
      action: 'user.password.reset',
      resourceType: 'user',
      resourceId: userId,
      details: {
        resetBy: req.user?.id || null,
      },
    });

    return res.status(200).json({
      message: 'Password reset successfully',
      user,
    });
  } catch (error) {
    console.error('Error resetting user password:', error);
    return res
      .status(500)
      .json({ error: error.message || 'Failed to reset password' });
  }
};
