#!/usr/bin/env python3
"""
Flow Generator for VURA Benchmarking Suite
Generates parameterized .flownb notebooks with:
1. HTTP Input schema (query/body validation)
2. SQL DuckDB cell generating N records (default 10,000)
3. Python cell data transformation via vura.io and pandas
4. JavaScript cell data enrichment via @vura-data-os/vura-io batch streaming
5. SQL modification / pagination joined with http_request
6. JSON HTTP Output cell
"""

import argparse
import os
import sys

def generate_flow_yaml(flow_index: int, flow_id: str, record_count: int = 10000) -> str:
    yaml_content = f"""version: 1
cells:
  - kind: 1
    language: markdown
    value: >-
      ## Benchmark Flow #{flow_index}: {flow_id}

      This flow generates {record_count:,} records in-memory via DuckDB, transforms
      them with Python (pandas) and JavaScript (@vura-data-os/vura-io streaming), and returns
      paginated JSON output filtered by query parameters.
    metadata: {{}}
  - kind: 2
    language: http-input
    value: |-
      {{
        "x-http-method": "get",
        "type": "object",
        "properties": {{
          "query": {{
            "type": "object",
            "properties": {{
              "page": {{ "type": "string" }},
              "page_size": {{ "type": "string" }},
              "request_id": {{ "type": "string" }},
              "filter_tier": {{ "type": "string" }}
            }}
          }}
        }}
      }}
    metadata: {{}}
  - kind: 2
    language: sql
    value: |-
      -- Step 1: Populate in-memory DuckDB table with {record_count} records for flow {flow_id}
      CREATE OR REPLACE TABLE raw_dataset AS
      SELECT 
        range AS id,
        '{flow_id}_' || range AS username,
        'user_' || range || '@{flow_id}.test' AS email,
        CAST(1000 + (random() * 9000) AS INT) AS raw_score,
        '{flow_id}' AS flow_origin,
        CASE 
          WHEN random() > 0.6 THEN 'Enterprise'
          WHEN random() > 0.3 THEN 'Pro'
          ELSE 'Free'
        END AS plan_tier
      FROM range(1, {record_count + 1});
    metadata:
      group: data-prep
      label: init_dataset
  - kind: 2
    language: python
    value: |-
      # Step 2: Python transformation via vura.io
      from vura.io import data
      import pandas as pd

      df = data.get("raw_dataset")
      df["calculated_score"] = (df["raw_score"] * 1.15).round(2)
      df["flow_verified"] = "{flow_id}"
      df["status"] = "Verified"

      data.put("python_processed", df)
      print(f"[Flow {flow_id}] Python processed {{len(df)}} records.")
    metadata:
      group: data-prep
      label: python_transform
  - kind: 2
    language: javascript
    value: >-
      // Step 3: JS enrichment via @vura-data-os/vura-io streaming in chunks
      import {{ data }} from "@vura-data-os/vura-io";

      async function processFlow() {{
        let count = 0;
        for await (const batch of data.stream("python_processed", {{ batchSize: 50000 }})) {{
          const enriched = batch.map(r => ({{
            ...r,
            is_high_tier: r.plan_tier === "Enterprise" || r.plan_tier === "Pro",
            audit_tag: `AUDIT_{flow_id}_${{Date.now()}}`
          }}));
          await data.append("final_dataset", enriched);
          count += batch.length;
        }}
        console.log(`[Flow {flow_id}] JS enriched ${{count}} records into final_dataset.`);
      }}

      await processFlow();
    metadata:
      group: data-prep
      label: js_enrich
  - kind: 2
    language: sql
    value: |-
      -- Step 4: Apply pagination from http_request
      CREATE OR REPLACE TABLE paginated_output AS
      WITH params AS (
        SELECT 
          COALESCE(TRY_CAST(query.page AS INT), 1) as current_page,
          COALESCE(TRY_CAST(query.page_size AS INT), 10) as page_size,
          COALESCE(query.request_id, 'req_default') as request_id
        FROM http_request
      )
      SELECT 
        f.id,
        f.username,
        f.email,
        f.raw_score,
        f.calculated_score,
        f.status,
        f.plan_tier,
        f.is_high_tier,
        f.flow_origin,
        f.flow_verified,
        f.audit_tag,
        p.request_id,
        p.current_page,
        p.page_size,
        (SELECT COUNT(*) FROM final_dataset) as total_count,
        CAST(CEIL((SELECT COUNT(*) FROM final_dataset)::DOUBLE / p.page_size) AS INT) as total_pages
      FROM final_dataset f, params p
      ORDER BY f.id ASC
      LIMIT (SELECT page_size FROM params)
      OFFSET ((SELECT current_page FROM params) - 1) * (SELECT page_size FROM params);
    metadata:
      group: api-handler
      label: sql_paginate
  - kind: 2
    language: json
    value: >-
      {{
        "$headers": {{
          "Content-Type": "application/json",
          "X-Vura-Flow-Id": "{flow_id}",
          "X-Vura-Records": "{record_count}"
        }},
        "$body": {{
          "status": "success",
          "flow_id": "{flow_id}",
          "pagination": {{
            "$query": "SELECT request_id, current_page, page_size, total_count, total_pages FROM paginated_output LIMIT 1",
            "$as": "single"
          }},
          "data": {{
            "$query": "SELECT id, username, email, raw_score, calculated_score, status, plan_tier, is_high_tier, flow_origin, flow_verified, audit_tag FROM paginated_output",
            "$as": "array"
          }}
        }}
      }}
    metadata:
      group: api-handler
      vura_is_http_output: true
      label: json_response
"""
    return yaml_content


def main():
    parser = argparse.ArgumentParser(description="Generate parameterized .flownb notebooks for VURA benchmarking")
    parser.add_argument("--count", type=int, default=10, help="Number of flow files to generate (default: 10)")
    parser.add_argument("--records", type=int, default=10000, help="Number of records per flow (default: 10000)")
    parser.add_argument("--output-dir", type=str, default="tests/flows", help="Target directory (default: tests/flows)")
    parser.add_argument("--prefix", type=str, default="flow", help="File prefix (default: flow)")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    generated_files = []

    print(f"Generating {args.count} .flownb notebooks in '{args.output_dir}' ({args.records:,} records each)...")

    for i in range(1, args.count + 1):
        flow_id = f"{args.prefix}_{i:02d}"
        filename = f"{flow_id}.flownb"
        filepath = os.path.join(args.output_dir, filename)
        content = generate_flow_yaml(flow_index=i, flow_id=flow_id, record_count=args.records)

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        generated_files.append(filepath)
        print(f"  ✓ Created {filename}")

    print(f"\nSuccessfully generated {len(generated_files)} flows in '{args.output_dir}'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
