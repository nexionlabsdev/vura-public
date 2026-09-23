#!/bin/bash

# VURA Runner CLI Use Case Sample Script
# This script demonstrates the various capabilities of the vura-runner CLI.

# Path to the compiled CLI (run this script from the samples/ directory)
alias VURA_CLI="node ../packages/vura-runner/out/cli.js"

# (Optional) You can also use alias if installed globally:
# VURA_CLI="vura-runner"

echo "=========================================================="
echo "          VURA Runner CLI Demonstration Script            "
echo "=========================================================="

echo -e "\n--- 1. CREDENTIALS MANAGEMENT ---"

echo "> Setting up a new credential profile (dev_db)..."
# $VURA_CLI credentials add dev_db my-server my-db SqlLogin --username admin --secret my_password
VURA_CLI credentials add "local-sql-server-7043" localhost D365MockDB SqlLogin --username sa --secret Password123!

echo -e "\n> Updating the credential profile (changing database name)..."
$VURA_CLI credentials update dev_db --database my-updated-db

echo -e "\n> Listing all active credential profiles..."
$VURA_CLI credentials list

echo -e "\n> Removing the credential profile..."
$VURA_CLI credentials remove dev_db


echo -e "\n--- 2. ENVIRONMENT SETTINGS ---"

echo "> Setting global Python VENV environment folder..."
#$VURA_CLI config set vura.python.venvPath "/path/to/my/custom/venv"
VURA_CLI config set vura.python.venvPath .venv

echo -e "\n--- 3. NOTEBOOK EXECUTION ---"
SAMPLE_NOTEBOOK="../packages/vura-runner/test.flownb"

# Create a temporary notebook for the demonstration if it doesn't exist
if [ ! -f "$SAMPLE_NOTEBOOK" ]; then
cat <<EOF > $SAMPLE_NOTEBOOK
- kind: 2
  language: sql
  value: |
    SELECT 'Hello from Cell 1' as greeting;
  metadata:
    connectionId: local
- kind: 2
  language: sql
  value: |
    SELECT 'Hello from Cell 2' as greeting;
  metadata:
    connectionId: local
EOF
fi

echo -e "\n> Listing all cells in the notebook..."
$VURA_CLI list $SAMPLE_NOTEBOOK

echo -e "\n> Executing a specific cell (Cell #1)..."
$VURA_CLI execute $SAMPLE_NOTEBOOK --cell 1

echo -e "\n> Executing a specific cell and exporting its output..."
$VURA_CLI execute $SAMPLE_NOTEBOOK --cell 2 --output single_cell_output.json
echo "  (Check single_cell_output.json for the result)"

echo -e "\n> Executing all cells in the notebook..."
$VURA_CLI execute $SAMPLE_NOTEBOOK --output full_notebook_output.json
echo "  (Check full_notebook_output.json for the combined results)"

echo -e "\n=========================================================="
echo "                   Demonstration Complete                   "
echo "=========================================================="
