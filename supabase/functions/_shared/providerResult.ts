export interface ProviderResult {
  task_id?: string;
  result_url?: string;
  /** Structured outputs dict — each key is a named output handle */
  outputs: Record<string, string>;
  output_type: "video_url" | "image_url" | "text" | "audio_url" | "model_3d";
  provider_meta?: Record<string, unknown>;
  /** Number of distinct media units produced this run. Default 1.
   *  Set by executors that can emit multiple outputs per call (e.g.
   *  Banana / GPT-Image with n>1) so usage logging records the true
   *  unit count instead of undercounting cost. */
  output_count?: number;
}
