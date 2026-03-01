/* eslint-disable node/no-unsupported-features/es-syntax */
let ioServer = null;

const ADMIN_NAMESPACE = '/k-manage-realtime';

const setSocketServer = (io) => {
  ioServer = io;
};

const getAdminNamespace = () => {
  if (!ioServer) return null;
  try {
    return ioServer.of(ADMIN_NAMESPACE);
  } catch (error) {
    return null;
  }
};

const emitAdminEvent = (eventName, payload = {}) => {
  const namespace = getAdminNamespace();
  if (!namespace) return;
  namespace.emit(eventName, {
    ...payload,
    emittedAt: new Date().toISOString(),
  });
};

const emitIngestJobStatus = (jobId, payload = {}) => {
  if (!jobId) return;
  emitAdminEvent('ingest_job_status', {
    ...payload,
    jobId,
  });
};

const emitParseFileStatus = (fileName, payload = {}) => {
  if (!fileName) return;
  emitAdminEvent('parse_file_status', {
    ...payload,
    fileName,
  });
};

module.exports = {
  ADMIN_NAMESPACE,
  setSocketServer,
  emitIngestJobStatus,
  emitParseFileStatus,
};
