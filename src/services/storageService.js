import { storage } from "../firebase";
import {
  ref, uploadBytesResumable, getDownloadURL, deleteObject,
} from "firebase/storage";

// Upload a file for a receipt and return { url, path, name, type, size }.
// onProgress(0–100) is called during upload.
export async function uploadReceiptDocument(receiptId, file, onProgress) {
  const path    = `receipts/${receiptId}/${Date.now()}_${file.name}`;
  const fileRef = ref(storage, path);
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(fileRef, file);
    task.on(
      "state_changed",
      (snap) => onProgress?.(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      reject,
      async () => {
        const url = await getDownloadURL(task.snapshot.ref);
        resolve({ url, path, name: file.name, type: file.type, size: file.size });
      }
    );
  });
}

export async function deleteReceiptDocument(path) {
  await deleteObject(ref(storage, path));
}
