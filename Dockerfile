FROM osgeo/gdal:ubuntu-small-latest
ENV DEBIAN_FRONTEND=noninteractive
RUN curl -fsSL https://bun.sh/install | bash
RUN apt-get update && apt-get install -y postgresql-client xxd
RUN /root/.bun/bin/bun install -g geobuf
WORKDIR /app
COPY ./package.json /app/package.json
RUN cd /app && /root/.bun/bin/bun install
COPY . /app
CMD ["/root/.bun/bin/bunx", "zx", "table-to-geojson.ts"]