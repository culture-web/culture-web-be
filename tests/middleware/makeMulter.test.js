const httpMocks = require('node-mocks-http');
const make = require('../../middleware/makeMulterMiddleware');

describe('makeMulterUploadErrorMiddleware', () => {
  let multerUploadFunction;
  let req;
  let res;
  let next;

  beforeEach(() => {
    multerUploadFunction = jest.fn();
    req = httpMocks.createRequest();
    res = httpMocks.createResponse();
    next = jest.fn();
  });

  it('should handle MulterError', () => {
    const multerError = { name: 'MulterError', message: 'test error' };
    multerUploadFunction.mockImplementation((_req, _res, callback) => {
      callback(multerError);
    });

    const middleware = make(multerUploadFunction);
    middleware(req, res, next);

    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle other errors', () => {
    const otherError = new Error('test error');
    multerUploadFunction.mockImplementation((_req, _res, callback) => {
      callback(otherError);
    });

    const middleware = make(multerUploadFunction);
    middleware(req, res, next);
    console.log(res);
    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next if there is no error', () => {
    multerUploadFunction.mockImplementation((_req, _res, callback) => {
      callback(null);
    });

    const middleware = make(multerUploadFunction);
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
