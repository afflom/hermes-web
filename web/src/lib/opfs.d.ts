// Ambient declarations for the parts of the File System Access / OPFS API this build uses but that the
// pinned TypeScript lib.dom does not yet ship. The holospaces worker pages the guest disk into an OPFS
// κ-store via a sync access handle (worker-only), so only these members are declared — narrowly, to match
// what `holo-worker.ts` calls. (WHATWG File System Standard.)

interface FileSystemSyncAccessHandle {
  read(buffer: BufferSource, options?: { at?: number }): number;
  write(buffer: BufferSource, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface FileSystemDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface StorageManager {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
}
