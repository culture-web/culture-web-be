module.exports = function makeMulterUploadErrorMiddleware(
  multerUploadFunction,
) {
  return (req, res, next) =>
    // eslint-disable-next-line consistent-return
    multerUploadFunction(req, res, (err) => {
      // handle Multer error
      if (err && err.name && err.name === 'MulterError') {
        return res.status(500).send({
          error: err.name,
          message: `File upload error: ${err.message}`,
        });
      }
      // handle other errors
      if (err) {
        return res.status(500).send({
          error: 'FILE UPLOAD ERROR',
          message: `Something wrong ocurred when trying to upload the file`,
        });
      }
      next();
    });
};
