declare module 'parquetjs-lite' {
  export class ParquetSchema {
    constructor(schema: any);
  }
  export class ParquetWriter {
    static openFile(schema: ParquetSchema, path: string): Promise<ParquetWriter>;
    appendRow(row: any): Promise<void>;
    close(): Promise<void>;
  }
  export class ParquetReader {
    static openFile(path: string): Promise<ParquetReader>;
    getCursor(): ParquetCursor;
    close(): Promise<void>;
  }
  export class ParquetCursor {
    next(): Promise<any>;
  }
}
