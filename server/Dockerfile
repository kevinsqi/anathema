FROM node:16-alpine

WORKDIR /usr/server

# Install dependencies
COPY package.json .
COPY yarn.lock .
RUN yarn install

# Copy app source code into docker image
COPY . .

EXPOSE 3000

CMD ["yarn", "start"]
