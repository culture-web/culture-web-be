# Use the official Node.js image as the base image
FROM node:21

COPY . .

# Install dependencies
RUN npm install

# Expose the port on which the server will run
EXPOSE 3001

# Start the server
CMD ["npm", "start"]