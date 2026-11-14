export class AdapterActionError extends Error {
  readonly retcode: number;
  readonly data: unknown;

  constructor(message: string, retcode: number, data: unknown = null) {
    super(message);
    this.name = 'AdapterActionError';
    this.retcode = retcode;
    this.data = data;
  }
}
