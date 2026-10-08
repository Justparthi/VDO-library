/**
 * MediaStore — the three DB methods the host app must implement.
 * All methods return Promises so any async DB driver works.
 */
export interface MediaRecord {
  id: string;
  protected: boolean;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  createdAt: number; // unix ms
  updatedAt: number; // unix ms
}

export interface MediaStore {
  /** Persist a brand-new record (status = 'uploading'). */
  insert(record: MediaRecord): Promise<void>;
  /** Return the record, or undefined if not found. */
  find(id: string): Promise<MediaRecord | undefined>;
  /** Merge the given fields into the existing record. */
  update(id: string, fields: Partial<Omit<MediaRecord, 'id' | 'createdAt'>>): Promise<void>;
}
