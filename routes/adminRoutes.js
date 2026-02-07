const express = require('express');
const multer = require('multer');
const make = require('../middleware/makeMulterMiddleware');

const router = express.Router();

const adminController = require('../controllers/adminController');

// Multer for PDF uploads (memory storage)
const storage = multer.memoryStorage();
const upload = multer({ storage });
const uploadPdfMiddleware = make(upload.single('pdf'));

// Document ingestion
router.post('/ingest', adminController.ingestDocument);

// PDF ingestion with OCR fallback
router.post('/ingest-pdf', uploadPdfMiddleware, adminController.ingestPdf);
router.get('/jobs/:jobId/status', adminController.getIngestJobStatus);

// Page update
router.post('/update-page', adminController.updatePage);

// Knowledge base statistics
router.get('/knowledge-base/stats', adminController.getKnowledgeBaseStats);

// Knowledge base files (overview)
router.get('/knowledge-base/files', adminController.getKnowledgeBaseFiles);
router.get('/knowledge-base/folders', adminController.listFolders);
router.post('/knowledge-base/folders', adminController.createFolder);
router.delete(
  '/knowledge-base/folders/:folderName',
  adminController.deleteFolder,
);

// Enable/disable a file
router.post('/knowledge-base/:fileName/enable', adminController.setFileEnabled);

// Re-embed (refresh parsing) for a file
router.post('/knowledge-base/:fileName/reembed', adminController.reembedFile);

// Start parse job (async) and get status
router.post('/knowledge-base/:fileName/parse', adminController.startParseFile);
router.get('/knowledge-base/:fileName/status', adminController.getFileStatus);

// Rename and export
router.post('/knowledge-base/:fileName/rename', adminController.renameDocument);
router.get(
  '/knowledge-base/:fileName/export',
  adminController.exportDocumentText,
);

// Delete document
router.delete('/knowledge-base/:fileName', adminController.deleteDocument);

// Chunk operations
router.get('/knowledge-base/:fileName/chunks', adminController.getFileChunks);
router.get('/knowledge-base/:fileName/pdf', adminController.getFilePdf);
router.put('/chunks/:chunkId', adminController.updateChunk);
router.delete('/chunks/:chunkId', adminController.deleteChunk);

// Bulk chunk operations
router.post('/chunks/bulk-enable', adminController.bulkEnableChunks);
router.post('/chunks/bulk-disable', adminController.bulkDisableChunks);
router.post('/chunks/bulk-delete', adminController.bulkDeleteChunks);

module.exports = router;
