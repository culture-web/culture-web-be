const express = require('express');
const multer = require('multer');
const make = require('../middleware/makeMulterMiddleware');
const { requireKbRoles } = require('../middleware/authMiddleware');

const router = express.Router();

const adminController = require('../controllers/adminController');

// Multer for PDF uploads (memory storage)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
});
const uploadPdfMiddleware = make(upload.single('pdf'));

// Document ingestion
router.post(
  '/ingest',
  requireKbRoles('admin', 'editor'),
  adminController.ingestDocument,
);

// PDF ingestion with OCR fallback
router.post(
  '/ingest-pdf',
  requireKbRoles('admin', 'editor'),
  uploadPdfMiddleware,
  adminController.ingestPdf,
);
router.get('/jobs/:jobId/status', adminController.getIngestJobStatus);

// ability to wipe all job records (admin only)
router.delete('/jobs', requireKbRoles('admin'), adminController.clearJobs);

// Page update
router.post(
  '/update-page',
  requireKbRoles('admin', 'editor'),
  adminController.updatePage,
);

// Knowledge base statistics
router.get('/knowledge-base/stats', adminController.getKnowledgeBaseStats);

// Knowledge base files (overview)
router.get('/knowledge-base/files', adminController.getKnowledgeBaseFiles);
router.get('/knowledge-base/folders', adminController.listFolders);
router.post(
  '/knowledge-base/folders',
  requireKbRoles('admin', 'editor'),
  adminController.createFolder,
);
router.delete(
  '/knowledge-base/folders/:folderName',
  requireKbRoles('admin', 'editor'),
  adminController.deleteFolder,
);

// Enable/disable a file
router.post(
  '/knowledge-base/:fileName/enable',
  requireKbRoles('admin', 'editor'),
  adminController.setFileEnabled,
);

// Re-embed (refresh parsing) for a file
router.post(
  '/knowledge-base/:fileName/reembed',
  requireKbRoles('admin', 'editor'),
  adminController.reembedFile,
);

// Start parse job (async) and get status
router.post(
  '/knowledge-base/:fileName/parse',
  requireKbRoles('admin', 'editor'),
  adminController.startParseFile,
);
router.get('/knowledge-base/:fileName/status', adminController.getFileStatus);

// Rename and export
router.post(
  '/knowledge-base/:fileName/rename',
  requireKbRoles('admin', 'editor'),
  adminController.renameDocument,
);
router.get(
  '/knowledge-base/:fileName/export',
  adminController.exportDocumentText,
);

// Delete document
router.delete(
  '/knowledge-base/:fileName',
  requireKbRoles('admin', 'editor'),
  adminController.deleteDocument,
);

// Chunk operations
router.get(
  '/knowledge-base/:fileName/summary',
  adminController.getDocumentSummary,
);
router.get(
  '/knowledge-base/:fileName/activity',
  adminController.getFileActivityHistory,
);
router.post(
  '/knowledge-base/:fileName/activity',
  requireKbRoles('admin', 'editor'),
  adminController.logFileActivity,
);
router.get('/knowledge-base/:fileName/chunks', adminController.getFileChunks);
router.get('/knowledge-base/:fileName/pdf', adminController.getFilePdf);
router.get('/knowledge-base/:fileName/download', adminController.downloadFile);
router.put(
  '/chunks/:chunkId',
  requireKbRoles('admin', 'editor'),
  adminController.updateChunk,
);
router.delete(
  '/chunks/:chunkId',
  requireKbRoles('admin', 'editor'),
  adminController.deleteChunk,
);

// Bulk chunk operations
router.post(
  '/chunks/bulk-enable',
  requireKbRoles('admin', 'editor'),
  adminController.bulkEnableChunks,
);
router.post(
  '/chunks/bulk-disable',
  requireKbRoles('admin', 'editor'),
  adminController.bulkDisableChunks,
);
router.post(
  '/chunks/bulk-delete',
  requireKbRoles('admin', 'editor'),
  adminController.bulkDeleteChunks,
);

// Admin user management
router.get('/users', adminController.listUsers);
router.post('/users', adminController.createUser);
router.patch('/users/:userId/role', adminController.updateUserRole);
router.post('/users/:userId/reset-password', adminController.resetUserPassword);

module.exports = router;
