FROM node:20-alpine

WORKDIR /app

# 依赖安装纳入镜像构建
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 应用代码与内置示例目标
COPY server.js astro.js ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
