import { readFileRecord, type Manifest } from './format';

type Request = { id: number; directory: string; file: string; record: Manifest['files'][string] };
self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, directory, file, record } = event.data;
  try {
    const bytes = await readFileRecord(new URL(directory), file, record);
    self.postMessage({ id, bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
