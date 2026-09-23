#!/usr/bin/env bash
set -e

echo "============================================================"
echo "⚡ VURA Automated Benchmark & Stability Test Orchestrator"
echo "============================================================"

# 1. Compile TypeScript runner
echo "--> Compiling vura-runner TypeScript packages..."
npm --prefix packages/core/vura-runner run compile

# 2. Generate 10 parameterized flows
echo "--> Generating 10 sample .flownb notebooks (10K records each)..."
python3 tests/generate_flows.py --count 10 --records 10000 --output-dir tests/flows

# 3. Run Benchmark Suite (10 concurrent users, 20 requests across HTTP and CLI execute)
echo "--> Executing benchmark suite (HTTP + Execute, 10 concurrent users)..."
python3 tests/benchmark_suite.py --flows 10 --concurrency 10 --requests 20 --mode both --report tests/benchmark_report.html

echo "--> Benchmark suite run finished successfully."
echo "--> Open tests/benchmark_report.html to view the interactive dashboard."
