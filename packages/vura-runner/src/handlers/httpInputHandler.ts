import { IVuraEnvironment, ICellLogger } from '../interfaces';
import { DuckDbManager } from '../services/duckDbManager';

export async function handleHttpInput(
    schemaStr: string,
    env: IVuraEnvironment,
    logger: ICellLogger,
    duckDb: DuckDbManager
): Promise<void> {
    const Ajv = require('ajv');
    const ajv = new Ajv();

    let schema;
    try {
        schema = JSON.parse(schemaStr);
    } catch (err: any) {
        throw new Error(`Failed to parse http-input JSON Schema: ${err.message}`);
    }

    // Try to load the http_request from DuckDB
    let requestRows;
    try {
        requestRows = await duckDb.runQuery('SELECT * FROM http_request LIMIT 1');
    } catch (err) {
        // Table might not exist if run from normal CLI without injectHttpRequest
        // Allow it to pass gracefully if no request context exists, or mock it
        await logger.logText('No HTTP request context injected. Skipping schema validation.');
        return;
    }

    if (!requestRows || requestRows.length === 0) {
        await logger.logText('Empty HTTP request context. Skipping schema validation.');
        return;
    }

    const requestData = requestRows[0];
    
    // Some light parsing since DuckDB might return strings for nested JSON
    if (typeof requestData.query === 'string') requestData.query = JSON.parse(requestData.query);
    if (typeof requestData.body === 'string') requestData.body = JSON.parse(requestData.body);
    if (typeof requestData.headers === 'string') requestData.headers = JSON.parse(requestData.headers);

    const validate = ajv.compile(schema);
    const valid = validate(requestData);

    if (!valid) {
        throw new Error(`HTTP Request Validation Failed: ${ajv.errorsText(validate.errors)}`);
    }

    await logger.logText('HTTP Request validated successfully against http-input schema.');
}
