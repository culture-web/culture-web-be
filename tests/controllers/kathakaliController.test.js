const axios = require('axios');
const httpMocks = require('node-mocks-http');
const { classifyCharacter } = require('../../controllers/kathakaliController');
const apiConfig = require('../../apiconfig/apiConfig');

jest.mock('axios');

describe('classifyCharacter', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = httpMocks.createRequest();
    res = httpMocks.createResponse();
    next = jest.fn();
  });

  it('should return 400 if no file is uploaded', async () => {
    await classifyCharacter(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'No file uploaded' });
  });

  it('should return 400 if the file type is not an image', async () => {
    req.file = { mimetype: 'text/plain' };
    await classifyCharacter(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid file type' });
  });

  it('should return 200 and the response from the microservice if the file is an image', async () => {
    req.file = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('test'),
      originalname: 'test.jpg',
    };
    const mockResponse = { data: 'test data' };
    axios.post.mockResolvedValue(mockResponse);

    await classifyCharacter(req, res, next);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual(mockResponse.data);
    expect(axios.post).toHaveBeenCalledWith(
      apiConfig.kathakaliCharacterClassificationApi,
      expect.anything(),
    );
  });

  it('should return 500 if there is an error with the microservice', async () => {
    req.file = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('test'),
      originalname: 'test.jpg',
    };

    const errorMessage = 'Error uploading image to microservice';
    axios.post.mockRejectedValue(new Error(errorMessage));
    await classifyCharacter(req, res, next);
    expect(res.statusCode).toBe(500);
  });
});
