#!/usr/bin/env zx

import { $, ProcessOutput, spinner } from "zx";

const queryPostgres = async (
  query: string,
  filePath: string = ""
): Promise<ProcessOutput> => {
  if (filePath.length === 0) {
    try {
      console.time(`[queryPostgres] Executed query: ${query}`);
      const output = await spinner(`[queryPostgres] Executing query...`, () => {
        return $`
          PGPASSWORD=$POSTGRES_PASSWORD psql \
          --dbname=$POSTGRES_DBNAME \
          --username=$POSTGRES_USER \
          --host=$POSTGRES_HOST \
          --port=$POSTGRES_PORT \
          -t \
          -c ${query}
        `
      });
      console.timeEnd(`[queryPostgres] Executed query: ${query}`);
      return output;
    }
    catch (e) {
      console.timeEnd(`[queryPostgres] Executed query: ${query}`);
      console.log(`[queryPostgres] Error: ${e}`);
      process.exit(1);
    }
  }
  try {
    console.time(`[queryPostgres] Exported query to file ${filePath}: ${query}`);
    const output = await spinner(`[queryPostgres] Exporting query to file ${filePath}...`, () => {
      return $`
        PGPASSWORD=$POSTGRES_PASSWORD psql \
        --dbname=$POSTGRES_DBNAME \
        --username=$POSTGRES_USER \
        --host=$POSTGRES_HOST \
        --port=$POSTGRES_PORT \
        -t \
        -c ${query} | xxd -p -r > ${filePath}
      `
    });
    console.timeEnd(`[queryPostgres] Exported query to file ${filePath}: ${query}`);
    return output;
  } catch (e) {
    console.timeEnd(`[queryPostgres] Exported query to file ${filePath}: ${query}`);
    console.log(`[queryPostgres] Error: ${e}`);
    process.exit(1);
  }
};

const tableToGeobufChunks = async (
  tableName: string,
  idColumn: string,
  geomColumn: string,
  chunkSize: number,
  filePath: string
): Promise<string> => {
  try {
    console.time(`[tableToGeobufChunks] Created ${tableName} in ${filePath}`);
    const baseFilePath = filePath.split(".gbf")[0];
    const countStr: ProcessOutput = await queryPostgres(`
      SELECT count(*) FROM ${tableName}
    `);
    const count = parseInt(countStr.stdout.trim());
    const columns = await queryPostgres(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = '${tableName}';
    `);
    let properties = columns
      .stdout
      .trim()
      .split('\n')
      .map(property => property.trim())
      .filter(property => ![idColumn, geomColumn].includes(property));
    let offset = 0;
    while (true) {
      if (offset > count) {
        break;
      }
      const partFilePath = `${baseFilePath}_${offset}.gbf`;
      await queryPostgres(`
        SELECT encode(ST_AsGeobuf(features, '${geomColumn}'), 'hex')
        FROM (
          SELECT
            ST_Transform(${geomColumn}, 4326) as ${geomColumn},
            ${idColumn}
            ${properties.length > 0 ? ', ' + properties.join(', ') : ''}
          FROM (
            SELECT *
            FROM ${tableName}
            WHERE ${idColumn} IN (
              SELECT ${idColumn}
              FROM ${tableName}
              ORDER BY ${idColumn}
              LIMIT ${chunkSize} OFFSET ${offset}
            )
          ) AS sq
        ) AS features;
      `, partFilePath);
      offset += chunkSize;
    }
    console.timeEnd(`[tableToGeobufChunks] Created ${tableName} in ${filePath}`);
    return filePath;
  } catch (e) {
    console.timeEnd(`[tableToGeobufChunks] Created ${tableName} in ${filePath}`);
    console.log(`[tableToGeobufChunks] Error: ${e}`);
    process.exit(1);
  }
};

const mergeGeobuf = async (
  filePath: string
): Promise<string> => {
  const baseFilePath = filePath.split(".geojson")[0];
  const outputPath = `${baseFilePath}.gbf`;
  try {
    // TODO
    return outputPath;
  } catch (e) {
    console.timeEnd(`[geojsonToGeobuf] Converted ${filePath} to ${outputPath}`);
    console.log(`[geojsonToGeobuf] Error: ${e}`);
    process.exit(1);
  }
}

// const tableName = process.env.TABLE_NAME || 'table';
// const idColumn = process.env.ID_COLUMN || 'id';
// const geomColumn = process.env.GEOM_COLUMN || 'geom';
// const chunkSize = parseInt(process.env.CHUNK_SIZE || '500000');
// const filePath = 'layer.gbf';
// await tableToGeobufChunks(tableName, idColumn, geomColumn, chunkSize, filePath);