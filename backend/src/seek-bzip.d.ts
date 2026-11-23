declare module 'seek-bzip' {
  const bzip: {
    decode(
      input: {
        read(buffer: Buffer, offset: number, length: number): number;
        readByte(): number;
      },
      output: { writeByte(byte: number): void },
    ): void;
  };
  export default bzip;
}
