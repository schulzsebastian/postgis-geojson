## How to Generate a GeoJSON File from a PostGIS Table?

Tags: gis, postgis, gdal, geojson, geobuf, flatgeobuf, zx, bun, docker

### Introduction

Use PostGIS function `ST_AsGeoJSON` somehow like this:

```sql
SELECT ST_AsGeoJSON(ST_Transform(geom, 4326)) FROM table
```

End of topic.

Just kiddin’. It won't be that simple.

### Assumptions

We have a table named `table` which contains geometry in the _EPSG:3857_ format in the `geom` column, and an `id` column with a `PRIMARY KEY SERIAL`.

**Hint:** If your data is not in the _EPSG:4326_ coordinates system (which is the default for GeoJSON), it's a good idea to add an index for the transformation operation to _EPSG:4326_ before exporting.
You can do this with the following query:

```sql
CREATE INDEX idx_table_geom_transform_4326 ON table USING GIST(ST_Transform(geom, 4326));
```

### Structure

We need to provide a GeoJSON file in accordance with [RFC-7946](https://datatracker.ietf.org/doc/html/rfc7946) standards.
Given that we're dealing with a larger number of objects, our output object will be a _FeatureCollection_.
So, our query should look something like this:

```sql
SELECT jsonb_build_object(
    'type', 'FeatureCollection',
    'features', jsonb_agg(features.feature)
)
FROM (
    SELECT jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(ST_Transform(geom, 4326))::jsonb,
        'properties', to_jsonb(properties) - 'geom'
    ) AS feature
    FROM (
        SELECT *
        FROM table
    ) AS properties
) AS features;
```

In the query, we're constructing a _FeatureCollection_ object where, under the `features` key, we place a list of _Feature_ objects.
These features include the geometry, and in the `properties` key we place all object attributes excluding the geometry (we wouldn’t want to duplicate that in the attributes).

This query gets the job done entirely.
However, what if, for instance, we have about 10 million objects in the table and we need the GeoJSON file to generate vector tiles for a layer?
Running queries that encompass so many rows and consume so much of the database's time and resources isn't best practice.
Moreover, the _JSONB_ field has its own size constraints, capped at around [255MB](https://github.com/postgres/postgres/blob/master/src/include/utils/jsonb.h#L138).

### Chunks

We can break down our query into several smaller parts by determining the size of each chunk of data.
In this case, we can use the _WHERE_ clause combined with _LIMIT_ and _OFFSET_:

```sql
SELECT jsonb_build_object(
  'type', 'FeatureCollection',
  'features', jsonb_agg(features.feature)
)
FROM (
  SELECT jsonb_build_object(
    'type', 'Feature',
    'geometry', ST_AsGeoJSON(ST_Transform(geom, 4326))::jsonb,
    'properties', to_jsonb(properties) - 'geom'
  ) AS feature
  FROM (
    SELECT *
    FROM table
    WHERE id IN (
        SELECT id
        FROM table
        ORDER BY id
        LIMIT 1000000 OFFSET 0
    )
  ) AS properties
) AS features;
```

In this query, we added a _WHERE_ clause which contains a subquery fetching data based on _LIMIT_ and _OFFSET_. This is extracted into a subquery for [optimization purposes](https://stackoverflow.com/a/6618428). The _ORDER BY_ is also essential due to [unique ordering considerations](https://www.postgresql.org/docs/current/queries-limit.html).

Now that we have multiple GeoJSON files, we might want to merge them into a single file. A great tool for this job is [ogrmerge.py](https://gdal.org/programs/ogrmerge.html) from the [GDAL](https://gdal.org/) package, which allows for merging multiple layers into single one.

```bash
ogrmerge.py -overwrite_ds -single -f GeoJSON -o /layer.geojson layer_*.geojson
```

This command creates a `layer.geojson` file based on partial files named `layer_*.geojson` (where `*` stands for the subsequent component).

### Postprocessing

For purposes such as processing, storage, and transferring between servers, it's a good idea to compress large files.
There are several methods available:

- `gzip`
- Converting to [TopoJSON](https://github.com/topojson/topojson)
- Simplification using [Mapshaper](https://github.com/mbloch/mapshaper)
- Direct simplification through [ogr2ogr -simplify](https://gdal.org/programs/ogr2ogr.html) during export
- Using the `FlatGeobuf` format supported directly by PostGIS via [ST_AsFlatGeobuf](https://postgis.net/docs/ST_AsFlatGeobuf.html) and GDAL
- ... and surely, one can find even more options

However, the most significant benefits (especially when generating vector tiles) were provided by [Geobuf](https://github.com/mapbox/geobuf).
We can also generate this from PostGIS using [ST_AsGeobuf](https://postgis.net/docs/ST_AsGeobuf.html).
The decision factors include:

- Nearly lossless reduction of GeoJSON output files, e.g. 1 million rows from ~300MB to ~40MB
- Support for [Tippecanoe](https://github.com/mapbox/tippecanoe)
- Tools provided by _Mapbox_ such as `json2geobuf`, `shp2geobuf`, and `geobuf2json`.

On the downside, I couldn't find a direct function to merge the output `*.gbf` files into one. As a result, I'm compelled to generate partial `*.geojson` files, merge them, and then generate a `*.gbf` file using `json2geobuf`.

### Write some code

To be universally applicable, we'll write a `bash` code example enriched with the syntax provided by Google's `zx` library ([truly a tool for writing better scripts](https://google.github.io/zx/)). As our environment, we'll use [Bun](https://bun.sh/) for native TypeScript handling.

1. Preparation of a function for creating queries that accepts a path where the query result should be saved. If no path is provided, the query result is returned in the `ProcessOutput` object:

```typescript
#!/usr/bin/env zx

import { $, ProcessOutput, spinner } from "zx";

const queryPostgres = async (
  query: string,
  filePath: string = ""
): Promise<ProcessOutput> => {
  if (filePath.length === 0) {
    return await $`
      PGPASSWORD=$POSTGRES_PASSWORD psql \
      --dbname=$POSTGRES_DBNAME \
      --username=$POSTGRES_USER \
      --host=$POSTGRES_HOST \
      --port=$POSTGRES_PORT \
      -t \
      -c ${query}
    `;
  }
  return await $`
      PGPASSWORD=$POSTGRES_PASSWORD psql \
      --dbname=$POSTGRES_DBNAME \
      --username=$POSTGRES_USER \
      --host=$POSTGRES_HOST \
      --port=$POSTGRES_PORT \
      -t \
      -c ${query} >${filePath} 2>/dev/null
    `;
};
```

2. Preparing a function using _LIMIT_ and _OFFSET_ that accepts the table name, geometry column name, id column name, the size of the GeoJSON chunks, and the destination file path (note the extraction of the `count` value to know when to stop generating queries):

```typescript
const tableToGeojsonChunks = async (
  tableName: string,
  geomColumn: string,
  idColumn: string,
  chunkSize: number,
  filePath: string
): Promise<string> => {
  const countStr: ProcessOutput = await queryPostgres(`
    SELECT count(*) FROM ${tableName}
  `);
  const count = parseInt(countStr.stdout.trim());
  let offset = 0;
  while (true) {
    if (offset > count) {
      break;
    }
    const partFilePath = `${filePath.split(".geojson")[0]}_${offset}.geojson`;
    await queryPostgres(
      `
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
    `,
      partFilePath
    );
    offset += chunkSize;
  }
  return filePath;
};
```

Alternatively to the above solution, you can use the `ogr2ogr` tool in the following way:

```typescript
$`
  ogr2ogr -t_srs EPSG:4326 -f GeoJSON ${partFilePath} \
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
`;
```

3. Preparing a function that combines the resulting parts into one layer and deletes the component parts:

```typescript
const mergeGeojson = async (filePath: string): Promise<string> => {
  const chunksPattern = `${filePath.split(".geojson")[0]}_*.geojson`;
  await $`ogrmerge.py -overwrite_ds -single -f GeoJSON -o ${filePath} ${chunksPattern}`.quiet();
  await $`find . -name ${chunksPattern} -delete`.quiet();
  return filePath;
};
```

4. Preparing a function that will convert from GeoJSON file to Geobuf.

```typescript
const geojsonToGeobuf = async (filePath: string): Promise<string> => {
  const outputPath = `${filePath.split(".geojson")[0]}.gbf`;
  await $`/root/.bun/bin/json2geobuf ${filePath} > ${outputPath}`.quiet();
};
```

### Summary

Managing and optimizing geospatial data, especially in a database environment like PostGIS, can present its own set of challenges. However, with the right tools and methodologies, it becomes not just manageable, but efficient and streamlined. From splitting larger datasets for manageable processing to employing various tools for better compression and data representation, the landscape of GIS data management is rich and versatile.

### Repository

1. Create _.env_ file (template in _.env.template_)
2. Run stack:

```bash
docker-compose up --build
```

3. Run script:

```bash
docker exec -it app bash run_geojson.sh
```
