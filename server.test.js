const request = require("supertest");
const app = require("./server");

describe("GET /", () => {
  it("should return status code 200", async () => {
    const response = await request(app).get("/");
    expect(response.statusCode).toBe(200);
    expect(response.text).toBe("Hello, this is your Express backend!");
  });
});
