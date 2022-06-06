FROM node:16-alpine

WORKDIR /usr/client

# Install dependencies
COPY package.json .
COPY yarn.lock .
RUN yarn install

# Copy app source code into docker image
COPY . .

CMD ["yarn", "start"]
