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
        -c ${query} >${filePath} 2>/dev/null
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

const tableToGeojsonChunks = async (
  tableName: string,
  geomColumn: string,
  idColumn: string,
  chunkSize: number,
  filePath: string
): Promise<string> => {
  try {
    console.time(`[tableToGeojson] Created ${tableName} in ${filePath}`);
    const baseFilePath = filePath.split(".geojson")[0];
    const countStr: ProcessOutput = await queryPostgres(`
      SELECT count(*) FROM ${tableName}
    `);
    const count = parseInt(countStr.stdout.trim());
    let offset = 0;
    while (true) {
      if (offset > count) {
        break;
      }
      const partFilePath = `${baseFilePath}_${offset}.geojson`;
      await $`rm -rf ${partFilePath}`.quiet();
      await queryPostgres(`
        SELECT jsonb_build_object(
          'type', 'FeatureCollection',
          'features', jsonb_agg(features.feature)
        )
        FROM (
          SELECT jsonb_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(ST_Transform(${geomColumn}, 4326))::jsonb,
            'properties', to_jsonb(properties) - '${geomColumn}'
          ) AS feature
          FROM (
            SELECT *
            FROM ${tableName}
            WHERE ${idColumn} IN (
              SELECT ${idColumn}
              FROM ${tableName}
              ORDER BY ${idColumn}
              LIMIT ${chunkSize} OFFSET ${offset}
            )
          ) AS properties
        ) AS features;
      `, partFilePath);
      offset += chunkSize;
    }
    console.timeEnd(`[tableToGeojson] Created ${tableName} in ${filePath}`);
    return filePath;
  } catch (e) {
    console.timeEnd(`[tableToGeojson] Created ${tableName} in ${filePath}`);
    console.log(`[tableToGeojson] Error: ${e}`);
    process.exit(1);
  }
};

const tableToGeojsonChunksOgr2ogr = async (
  tableName: string,
  idColumn: string,
  chunkSize: number,
  filePath: string
): Promise<string> => {
  try {
    console.time(`[tableToGeojsonChunksOgr2ogr] Created ${tableName} in ${filePath}`);
    const baseFilePath = filePath.split(".geojson")[0];
    const countStr: ProcessOutput = await queryPostgres(`
      SELECT count(*) FROM ${tableName}
    `);
    const count = parseInt(countStr.stdout.trim());
    let offset = 0;
    while (true) {
      if (offset > count) {
        break;
      }
      const partFilePath = `${baseFilePath}_${offset}.geojson`;
      await $`rm -rf ${partFilePath}`.quiet();
      console.time(`[tableToGeojsonChunksOgr2ogr] Processed ${offset}`);
      console.log(`Processing ${offset}`)
      await $`ogr2ogr -t_srs EPSG:4326 -f GeoJSON ${partFilePath} \
        "PG:host=$POSTGRES_HOST dbname=$POSTGRES_DBNAME user=$POSTGRES_USER password=$POSTGRES_PASSWORD" \
        -sql '
          SELECT *
          FROM ${tableName}
          WHERE ${idColumn} IN (
            SELECT ${idColumn}
            FROM ${tableName}
            ORDER BY ${idColumn}
            LIMIT ${chunkSize} OFFSET ${offset}
          )
        '
      `.quiet();
      console.timeEnd(`[tableToGeojsonChunksOgr2ogr] Processed ${offset}`);
      offset += chunkSize;
    }
    console.timeEnd(`[tableToGeojsonChunksOgr2ogr] Created ${tableName} in ${filePath}`);
    return filePath;
  } catch (e) {
    console.timeEnd(`[tableToGeojsonChunksOgr2ogr] Created ${tableName} in ${filePath}`);
    console.log(`[tableToGeojsonChunksOgr2ogr] Error: ${e}`);
    process.exit(1);
  }
};

const mergeGeojson = async (
  filePath: string
): Promise<string> => {
  try {
    console.time(`[mergeGeojson] Merged chunks to ${filePath}`);
    const baseFilePath = filePath.split(".geojson")[0];
    const chunksPattern = `${baseFilePath}_*.geojson`;
    await spinner(`[mergeGeojson] Merging chunks...`, () => {
      return $`ogrmerge.py -overwrite_ds -single -f GeoJSON -o ${filePath} ${chunksPattern}`.quiet()
    });
    await spinner(`[mergeGeojson] Deleting chunks...`, () => {
      return $`find . -name ${chunksPattern} -delete`.quiet();
    });
    return filePath;
  } catch (e) {
    console.timeEnd(`[mergeGeojson] Merged chunks to ${filePath}`);
    console.log(`[mergeGeojson] Error: ${e}`);
    process.exit(1);
  }
}

const geojsonToGeobuf = async (
  filePath: string
): Promise<string> => {
  const baseFilePath = filePath.split(".geojson")[0];
  const outputPath = `${baseFilePath}.gbf`;
  try {
    console.time(`[geojsonToGeobuf] Converted ${filePath} to ${outputPath}`);
    await spinner(`[geojsonToGeobuf] Converting geojson to geobuf...`, () => {
      return $`/root/.bun/bin/json2geobuf ${filePath} > ${outputPath}`.quiet()
    });
    return outputPath;
  } catch (e) {
    console.timeEnd(`[geojsonToGeobuf] Converted ${filePath} to ${outputPath}`);
    console.log(`[geojsonToGeobuf] Error: ${e}`);
    process.exit(1);
  }
}

const tableName = process.env.TABLE_NAME || 'table';
const geomColumn = process.env.GEOM_COLUMN || 'geom';
const idColumn = process.env.ID_COLUMN || 'id';
const chunkSize = parseInt(process.env.CHUNK_SIZE || '1000000');
const filePath = 'layer.geojson';
// await tableToGeojsonChunks(tableName, geomColumn, idColumn, chunkSize, filePath);
await tableToGeojsonChunksOgr2ogr(tableName, idColumn, chunkSize, filePath)
await mergeGeojson(filePath);
await geojsonToGeobuf(filePath);