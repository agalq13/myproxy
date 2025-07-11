FROM node:18-bullseye-slim

WORKDIR /app
COPY . .

RUN npm install --save-dev patch-package postinstall-postinstall
RUN npm install --package-lock-only
RUN npm ci
RUN npm run build
RUN npm prune --production

EXPOSE 7860
ENV PORT=7860
ENV NODE_ENV=production

CMD [ "npm", "start" ]
