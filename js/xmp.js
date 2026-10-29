// Adds Google "Photo Sphere" (GPano) XMP metadata to a JPEG, so Google Photos, Facebook and
// other viewers recognize it as an interactive 360° photo. The XMP goes in an APP1 segment.

const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";

export async function addGPanoXmp(jpegBlob, { width, height, headingDeg }) {
  const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("That isn't a JPEG.");
  // Insert right after the start marker, or after the JFIF (APP0) segment if there is one,
  // since JFIF has to come first.
  let pos = 2;
  if (bytes[2] === 0xff && bytes[3] === 0xe0) pos = 4 + ((bytes[4] << 8) | bytes[5]);

  const payload = new TextEncoder().encode(XMP_HEADER + xmpPacket(width, height, headingDeg));
  const length = payload.length + 2; // the length field counts itself
  if (length > 0xffff) throw new Error("XMP metadata is too large.");
  const header = new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff]);
  return new Blob([bytes.subarray(0, pos), header, payload, bytes.subarray(pos)], { type: "image/jpeg" });
}

function xmpPacket(width, height, headingDeg) {
  const heading = headingDeg == null ? "" : `\n      GPano:PoseHeadingDegrees="${headingDeg.toFixed(1)}"`;
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"
      GPano:ProjectionType="equirectangular"
      GPano:UsePanoramaViewer="True"
      GPano:CaptureSoftware="Sphere Cam"
      GPano:StitchingSoftware="Sphere Cam"
      GPano:FullPanoWidthPixels="${width}"
      GPano:FullPanoHeightPixels="${height}"
      GPano:CroppedAreaImageWidthPixels="${width}"
      GPano:CroppedAreaImageHeightPixels="${height}"
      GPano:CroppedAreaLeftPixels="0"
      GPano:CroppedAreaTopPixels="0"${heading}/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}
