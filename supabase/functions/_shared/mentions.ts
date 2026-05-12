/// <reference lib="deno.ns" />
/// <reference lib="dom" />

/** Server-side mirror of the frontend `MentionedAsset` shape. */
export interface MentionedAssetSrv {
  /** "asset" = AssetNode (image/video); "element" = saved/creator
   *  ElementNode resolved to a Kling Omni element entry. */
  kind?: "asset" | "element";
  label?: string;
  nodeId?: string;
  /** Asset-only. */
  url?: string | null;
  fieldType?: "image" | "video" | "audio" | null;
  role?: string;
  /** Element-only. */
  name?: string;
  reference_image_urls?: string[];
  frontal_image_url?: string;
  brand_element_id?: string;
}
