interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
}

interface DriveFilesListResponse {
  files?: DriveFile[];
}

/**
 * Finds a Drive file by exact NAME rather than file ID. The source file is
 * deleted and recreated with the same name every week, so its ID is not
 * stable -- name-based lookup, taking the most recently modified match, is
 * required.
 */
export async function findFileIdByName(token: string, fileName: string): Promise<string> {
  const q = encodeURIComponent(`name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`);
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${q}` +
    `&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)&pageSize=5`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await resp.json()) as DriveFilesListResponse;

  const file = data.files?.[0];
  if (!file) {
    throw new Error(`No Drive file found named "${fileName}"`);
  }
  return file.id;
}
