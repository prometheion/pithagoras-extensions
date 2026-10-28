/** Helpers of docchat.test.mts: the store's documents, and a saved docx that holds the given comment threads. */
import JSZip from "jszip";
export { createDoc, getDoc } from "../src/store";

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"`;

/** A docx as the editor saves it, with one comment per [guid, text] (by Portal), its durableId the GUID; a GUID of
 * "" has no durableId (as an outside tool saves it). */
export async function rewriteZipFor(threads: [string, string][]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document ${W}><w:body><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>`);
  zip.file("word/comments.xml", `<w:comments ${W}>${threads.map(([, text], i) => `<w:comment w:id="${i}" w:author="Portal"><w:p w14:paraId="${(0x100 + i).toString(16).toUpperCase().padStart(8, "0")}"><w:r><w:t>${text}</w:t></w:r></w:p></w:comment>`).join("")}</w:comments>`);
  zip.file("word/commentsIds.xml", `<w16cid:commentsIds ${W}>${threads.map(([guid], i) => (guid ? `<w16cid:commentId w16cid:paraId="${(0x100 + i).toString(16).toUpperCase().padStart(8, "0")}" w16cid:durableId="${guid.toUpperCase()}"/>` : "")).join("")}</w16cid:commentsIds>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
