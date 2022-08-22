FROM node:16 as builder

COPY package.json ./
RUN yarn install

COPY . .
EXPOSE 3000

CMD ["yarn", "start"]
