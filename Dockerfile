FROM node:10

COPY package.json ./
RUN npm install

COPY index.js ./
CMD ["./index.js"]
