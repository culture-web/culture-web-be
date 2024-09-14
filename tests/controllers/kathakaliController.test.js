const axios = require('axios');
const httpMocks = require('node-mocks-http');
const {
  classifyCharacter,
  classifyExpression,
} = require('../../controllers/kathakaliController');
const apiConfig = require('../../apiconfig/apiConfig');

jest.mock('axios');

describe('classifyExpression', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = httpMocks.createRequest();
    res = httpMocks.createResponse();
    next = jest.fn();
  });

  it('should return 400 if no file is uploaded', async () => {
    await classifyExpression(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'No file uploaded' });
  });

  it('should return 400 if the file type is not an image', async () => {
    req.file = { mimetype: 'text/plain' };
    await classifyExpression(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid file type' });
  });

  it('should classify expressions and return 200', async () => {
    req.file = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('test'),
      originalname: 'test.jpg',
    };
    const faceMockData = ['expression1_encoded', 'expression2_encoded'];
    const locationMockData = ['location1', 'location2'];

    axios.post
      .mockResolvedValueOnce({
        data: { faces: faceMockData, locations: locationMockData },
      })
      .mockResolvedValueOnce({
        data: { prediction: 'Love' },
      })
      .mockResolvedValueOnce({
        data: { prediction: 'Comic' },
      });

    await classifyExpression(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual([
      { prediction: 'Love', location: 'location1' },
      { prediction: 'Comic', location: 'location2' },
    ]);
  });

  it('should return 500 if there is an error with the microservice', async () => {
    req.file = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('test'),
      originalname: 'test.jpg',
    };

    const errorMessage = 'Error uploading image to microservice';
    axios.post.mockRejectedValue(new Error(errorMessage));
    await classifyExpression(req, res, next);
    expect(res.statusCode).toBe(500);
  });
});

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

  // it('should return 200 and the response from the microservice if the file is an image', async () => {
  //   req.file = {
  //     mimetype: 'image/jpeg',
  //     buffer: Buffer.from('test'),
  //     originalname: 'test.jpg',
  //   };
  //   const mockResponse = { data: 'test data' };
  //   axios.post.mockResolvedValue(mockResponse);

  //   await classifyCharacter(req, res, next);
  //   expect(res.statusCode).toBe(200);
  //   expect(res._getJSONData()).toEqual(mockResponse.data);
  //   expect(axios.post).toHaveBeenCalledWith(
  //     apiConfig.kathakaliCharacterClassificationApi,
  //     expect.anything(),
  //   );
  // });

  it('should classify faces and return 200', async () => {
    req.file = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('test'),
      originalname: 'test.jpg',
    };
    const faceMockData = ['face1_encoded', 'face2_encoded'];
    const locationMockData = ['location1', 'location2'];

    axios.post
      .mockResolvedValueOnce({
        data: { faces: faceMockData, locations: locationMockData },
      })
      .mockResolvedValueOnce({
        data: { character: 'Kathakali Character 1' },
      })
      .mockResolvedValueOnce({
        data: { character: 'Kathakali Character 2' },
      });

    await classifyCharacter(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual([
      { character: 'Kathakali Character 1', location: 'location1' },
      { character: 'Kathakali Character 2', location: 'location2' },
    ]);
  });

  it('should return error if classification fails for a face', async () => {
    req.file = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('test'),
      originalname: 'test.jpg',
    };

    const faceMockData = ['face1_encoded', 'face2_encoded'];
    const locationMockData = ['location1', 'location2'];

    axios.post
      .mockResolvedValueOnce({
        data: { faces: faceMockData, locations: locationMockData },
      })
      .mockResolvedValueOnce({
        data: { character: 'Kathakali Character 1' },
      })
      .mockRejectedValueOnce(new Error('Microservice error'));

    await classifyCharacter(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual([
      { character: 'Kathakali Character 1', location: 'location1' },
      { error: 'Failed to classify face' },
    ]);
  });
});
