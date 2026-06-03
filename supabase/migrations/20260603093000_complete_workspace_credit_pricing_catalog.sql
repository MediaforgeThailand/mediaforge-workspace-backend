-- Complete Workspace credit pricing coverage for currently exposed canvas
-- and standalone tools. Import/source utilities such as URL asset and MP3
-- input remain free in runtime code because they do not call a paid generator.

delete from public.credit_costs
where feature = 'upscale_image'
  and model = 'magnific-upscale-precision-v2';

delete from public.credit_costs
where feature = 'mp3_input';

with rows(
  feature,
  model,
  label,
  cost,
  pricing_type,
  duration_seconds,
  has_audio,
  provider,
  price_key,
  resolution,
  quality,
  source,
  source_url,
  source_ratio,
  provider_unit,
  notes
) as (
  values
    -- OpenAI GPT Image 2.
    ('generate_openai_image','gpt-image-2:1k:low','GPT Image 2 1K Low',21,'per_operation',null,false,'openai','gpt-image-2:1k:low','1K','low','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Replicate openai/gpt-image-2 low is $0.012/image; resolution is retained for runtime matching.'),
    ('generate_openai_image','gpt-image-2:1k:medium','GPT Image 2 1K Medium',83,'per_operation',null,false,'openai','gpt-image-2:1k:medium','1K','medium','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Replicate openai/gpt-image-2 medium is $0.047/image; resolution is retained for runtime matching.'),
    ('generate_openai_image','gpt-image-2:1k:high','GPT Image 2 1K High',224,'per_operation',null,false,'openai','gpt-image-2:1k:high','1K','high','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Replicate openai/gpt-image-2 high is $0.128/image; resolution is retained for runtime matching.'),
    ('generate_openai_image','gpt-image-2:1k:auto','GPT Image 2 1K Auto',224,'per_operation',null,false,'openai','gpt-image-2:1k:auto','1K','auto','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Auto is charged at the high tier until runtime telemetry supports a lower observed tier.'),
    ('generate_openai_image','gpt-image-2:2k:low','GPT Image 2 2K Low',21,'per_operation',null,false,'openai','gpt-image-2:2k:low','2K','low','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Replicate openai/gpt-image-2 bills by quality rather than resolution.'),
    ('generate_openai_image','gpt-image-2:2k:medium','GPT Image 2 2K Medium',83,'per_operation',null,false,'openai','gpt-image-2:2k:medium','2K','medium','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Replicate openai/gpt-image-2 bills by quality rather than resolution.'),
    ('generate_openai_image','gpt-image-2:2k:high','GPT Image 2 2K High',224,'per_operation',null,false,'openai','gpt-image-2:2k:high','2K','high','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Replicate openai/gpt-image-2 bills by quality rather than resolution.'),
    ('generate_openai_image','gpt-image-2:2k:auto','GPT Image 2 2K Auto',224,'per_operation',null,false,'openai','gpt-image-2:2k:auto','2K','auto','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Auto is charged at the high tier until runtime telemetry supports a lower observed tier.'),
    ('generate_openai_image','gpt-image-2:4k:low','GPT Image 2 4K Low',21,'per_operation',null,false,'openai','gpt-image-2:4k:low','4K','low','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Replicate openai/gpt-image-2 bills by quality rather than resolution.'),
    ('generate_openai_image','gpt-image-2:4k:medium','GPT Image 2 4K Medium',83,'per_operation',null,false,'openai','gpt-image-2:4k:medium','4K','medium','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Replicate openai/gpt-image-2 bills by quality rather than resolution.'),
    ('generate_openai_image','gpt-image-2:4k:high','GPT Image 2 4K High',224,'per_operation',null,false,'openai','gpt-image-2:4k:high','4K','high','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Replicate openai/gpt-image-2 bills by quality rather than resolution.'),
    ('generate_openai_image','gpt-image-2:4k:auto','GPT Image 2 4K Auto',224,'per_operation',null,false,'openai','gpt-image-2:4k:auto','4K','auto','replicate_docs','https://replicate.com/openai/gpt-image-2',1.0,'per image','Auto is charged at the high tier until runtime telemetry supports a lower observed tier.'),

    -- OpenAI GPT Image 2 enhancement/upscale.
    ('upscale_image','gpt-image-2-enhance:1k:low','Upscale Mediaforge 1K Low',11,'per_operation',null,false,'openai','gpt-image-2-enhance:1k:low','1K','low','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','OpenAI gpt-image-2 enhancement uses the image edits endpoint; input tokens are not yet metered separately.'),
    ('upscale_image','gpt-image-2-enhance:1k:medium','Upscale Mediaforge 1K Medium',93,'per_operation',null,false,'openai','gpt-image-2-enhance:1k:medium','1K','medium','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','OpenAI gpt-image-2 enhancement uses the image edits endpoint; input tokens are not yet metered separately.'),
    ('upscale_image','gpt-image-2-enhance:1k:high','Upscale Mediaforge 1K High',369,'per_operation',null,false,'openai','gpt-image-2-enhance:1k:high','1K','high','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','OpenAI gpt-image-2 enhancement uses the image edits endpoint; input tokens are not yet metered separately.'),
    ('upscale_image','gpt-image-2-enhance:1k:auto','Upscale Mediaforge 1K Auto',369,'per_operation',null,false,'openai','gpt-image-2-enhance:1k:auto','1K','auto','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','Auto is charged at the high tier until runtime telemetry supports a lower observed tier.'),
    ('upscale_image','gpt-image-2-enhance:2k:low','Upscale Mediaforge 2K Low',21,'per_operation',null,false,'openai','gpt-image-2-enhance:2k:low','2K','low','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','OpenAI gpt-image-2 enhancement uses the image edits endpoint; input tokens are not yet metered separately.'),
    ('upscale_image','gpt-image-2-enhance:2k:medium','Upscale Mediaforge 2K Medium',188,'per_operation',null,false,'openai','gpt-image-2-enhance:2k:medium','2K','medium','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','OpenAI gpt-image-2 enhancement uses the image edits endpoint; input tokens are not yet metered separately.'),
    ('upscale_image','gpt-image-2-enhance:2k:high','Upscale Mediaforge 2K High',750,'per_operation',null,false,'openai','gpt-image-2-enhance:2k:high','2K','high','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','OpenAI gpt-image-2 enhancement uses the image edits endpoint; input tokens are not yet metered separately.'),
    ('upscale_image','gpt-image-2-enhance:2k:auto','Upscale Mediaforge 2K Auto',750,'per_operation',null,false,'openai','gpt-image-2-enhance:2k:auto','2K','auto','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','Auto is charged at the high tier until runtime telemetry supports a lower observed tier.'),
    ('upscale_image','gpt-image-2-enhance:4k:low','Upscale Mediaforge 4K Low',20,'per_operation',null,false,'openai','gpt-image-2-enhance:4k:low','4K','low','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','OpenAI gpt-image-2 enhancement uses the image edits endpoint; input tokens are not yet metered separately.'),
    ('upscale_image','gpt-image-2-enhance:4k:medium','Upscale Mediaforge 4K Medium',176,'per_operation',null,false,'openai','gpt-image-2-enhance:4k:medium','4K','medium','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','OpenAI gpt-image-2 enhancement uses the image edits endpoint; input tokens are not yet metered separately.'),
    ('upscale_image','gpt-image-2-enhance:4k:high','Upscale Mediaforge 4K High',701,'per_operation',null,false,'openai','gpt-image-2-enhance:4k:high','4K','high','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','OpenAI gpt-image-2 enhancement uses the image edits endpoint; input tokens are not yet metered separately.'),
    ('upscale_image','gpt-image-2-enhance:4k:auto','Upscale Mediaforge 4K Auto',701,'per_operation',null,false,'openai','gpt-image-2-enhance:4k:auto','4K','auto','official_docs','https://developers.openai.com/api/docs/guides/image-generation',null,'per image edit','Auto is charged at the high tier until runtime telemetry supports a lower observed tier.'),

    -- Google image models.
    ('generate_freepik_image','nano-banana-2:1k','Nano Banana 2 1K',118,'per_operation',null,false,'google','gemini-3.1-flash-image-preview:1k','1K',null,'official_docs','https://ai.google.dev/gemini-api/docs/pricing',null,'per image','Workspace nano-banana-2 maps to Google Gemini 3.1 Flash Image Preview.'),
    ('generate_freepik_image','nano-banana-2:2k','Nano Banana 2 2K',177,'per_operation',null,false,'google','gemini-3.1-flash-image-preview:2k','2K',null,'official_docs','https://ai.google.dev/gemini-api/docs/pricing',null,'per image','Workspace nano-banana-2 maps to Google Gemini 3.1 Flash Image Preview.'),
    ('generate_freepik_image','nano-banana-2:4k','Nano Banana 2 4K',265,'per_operation',null,false,'google','gemini-3.1-flash-image-preview:4k','4K',null,'official_docs','https://ai.google.dev/gemini-api/docs/pricing',null,'per image','Workspace nano-banana-2 maps to Google Gemini 3.1 Flash Image Preview.'),
    ('generate_freepik_image','nano-banana-2','Nano Banana 2 fallback',118,'per_operation',null,false,'google','gemini-3.1-flash-image-preview:1k','1K',null,'official_docs','https://ai.google.dev/gemini-api/docs/pricing',null,'per image','Runtime fallback when an explicit image size is not passed.'),
    ('generate_freepik_image','nano-banana-pro:1k','Nano Banana Pro 1K',235,'per_operation',null,false,'google','gemini-3-pro-image-preview:1k','1K',null,'official_docs','https://ai.google.dev/gemini-api/docs/pricing',null,'per image','Workspace nano-banana-pro maps to Google Gemini 3 Pro Image Preview.'),
    ('generate_freepik_image','nano-banana-pro:2k','Nano Banana Pro 2K',235,'per_operation',null,false,'google','gemini-3-pro-image-preview:2k','2K',null,'official_docs','https://ai.google.dev/gemini-api/docs/pricing',null,'per image','Workspace nano-banana-pro maps to Google Gemini 3 Pro Image Preview.'),
    ('generate_freepik_image','nano-banana-pro:4k','Nano Banana Pro 4K',420,'per_operation',null,false,'google','gemini-3-pro-image-preview:4k','4K',null,'official_docs','https://ai.google.dev/gemini-api/docs/pricing',null,'per image','Workspace nano-banana-pro maps to Google Gemini 3 Pro Image Preview.'),
    ('generate_freepik_image','nano-banana-pro','Nano Banana Pro fallback',235,'per_operation',null,false,'google','gemini-3-pro-image-preview:1k','1K',null,'official_docs','https://ai.google.dev/gemini-api/docs/pricing',null,'per image','Runtime fallback when an explicit image size is not passed.'),

    -- Seedream image models.
    ('generate_seedream_image','seedream-5-0-260128','Seedream 5.0',60,'per_operation',null,false,'byteplus','seedream-5-0-260128',null,null,'master_pricing_sheet','https://www.byteplus.com/en/product/modelark',null,'per image','Master pricing sheet: $0.035/image rounded to 60 Workspace credits.'),
    ('generate_seedream_image','seedream-5-0','Seedream 5.0 alias',60,'per_operation',null,false,'byteplus','seedream-5-0-260128',null,null,'master_pricing_sheet','https://www.byteplus.com/en/product/modelark',null,'per image','Runtime alias for Seedream 5.0.'),
    ('generate_seedream_image','seedream-5-0-lite-260128','Seedream 5.0 Lite',60,'per_operation',null,false,'byteplus','seedream-5-0-lite-260128',null,null,'master_pricing_sheet','https://www.byteplus.com/en/product/modelark',null,'per image','Master pricing sheet: Seedream 5.0 Lite $0.035/image rounded to 60 Workspace credits.'),
    ('generate_seedream_image','seedream-4-5-251128','Seedream 4.5',60,'per_operation',null,false,'byteplus','seedream-4-5-251128',null,null,'needs_provider_invoice',null,null,'per image','Emergency floor aligned with Seedream 5.0 until invoice/SKU rate is confirmed.'),

    -- Video models with known gaps or stale rows.
    ('generate_freepik_video','seedance-1-5-pro-251215','Seedance 1.5 Pro no audio',100,'per_second',null,false,'seedance','seedance-1-5-pro-251215:default:silent',null,null,'master_pricing_sheet',null,null,'per second','Master pricing sheet: no audio approx 100 credits/sec.'),
    ('generate_freepik_video','seedance-1-5-pro-251215','Seedance 1.5 Pro + audio',200,'per_second',null,true,'seedance','seedance-1-5-pro-251215:default:audio',null,null,'master_pricing_sheet',null,null,'per second','Master pricing sheet: with audio approx 200 credits/sec.'),
    ('generate_freepik_video','seedance-2-0-lite:480p','Seedance 2.0 Fast 480p',140,'per_second',null,false,'seedance','seedance-2-0-lite:480p:non_video_in:silent','480p',null,'replicate_docs','https://replicate.com/bytedance/seedance-2.0',1.0,'per second','Replicate bytedance/seedance-2.0 non-video input 480p costs $0.08/sec.'),
    ('generate_freepik_video','seedance-2-0-lite:720p','Seedance 2.0 Fast 720p',315,'per_second',null,false,'seedance','seedance-2-0-lite:720p:non_video_in:silent','720p',null,'replicate_docs','https://replicate.com/bytedance/seedance-2.0',1.0,'per second','Replicate bytedance/seedance-2.0 non-video input 720p costs $0.18/sec.'),
    ('generate_freepik_video','seedance-2-0-lite','Seedance 2.0 Fast fallback',315,'per_second',null,false,'seedance','seedance-2-0-lite:default:non_video_in:silent',null,null,'replicate_docs','https://replicate.com/bytedance/seedance-2.0',1.0,'per second','Fallback uses the Replicate 720p non-video-input rate.'),
    ('generate_freepik_video','dreamina-seedance-2-0-fast-260128','Seedance 2.0 Fast direct-id fallback',315,'per_second',null,false,'seedance','dreamina-seedance-2-0-fast-260128:default:non_video_in:silent',null,null,'replicate_docs','https://replicate.com/bytedance/seedance-2.0',1.0,'per second','Direct BytePlus alias uses the Replicate 720p non-video-input rate.'),
    ('generate_freepik_video','seedance-2-0-pro:480p','Seedance 2.0 Pro 480p',140,'per_second',null,false,'seedance','seedance-2-0-pro:480p:non_video_in:silent','480p',null,'replicate_docs','https://replicate.com/bytedance/seedance-2.0',1.0,'per second','Replicate bytedance/seedance-2.0 non-video input 480p costs $0.08/sec.'),
    ('generate_freepik_video','seedance-2-0-pro:720p','Seedance 2.0 Pro 720p',315,'per_second',null,false,'seedance','seedance-2-0-pro:720p:non_video_in:silent','720p',null,'replicate_docs','https://replicate.com/bytedance/seedance-2.0',1.0,'per second','Replicate bytedance/seedance-2.0 non-video input 720p costs $0.18/sec.'),
    ('generate_freepik_video','seedance-2-0-pro:1080p','Seedance 2.0 Pro 1080p',788,'per_second',null,false,'seedance','seedance-2-0-pro:1080p:non_video_in:silent','1080p',null,'replicate_docs','https://replicate.com/bytedance/seedance-2.0',1.0,'per second','Replicate bytedance/seedance-2.0 non-video input 1080p costs $0.45/sec.'),
    ('generate_freepik_video','seedance-2-0-pro','Seedance 2.0 Pro fallback',315,'per_second',null,false,'seedance','seedance-2-0-pro:default:non_video_in:silent',null,null,'replicate_docs','https://replicate.com/bytedance/seedance-2.0',1.0,'per second','Fallback uses the Replicate 720p non-video-input rate.'),
    ('generate_freepik_video','dreamina-seedance-2-0-260128','Seedance 2.0 Pro direct-id fallback',315,'per_second',null,false,'seedance','dreamina-seedance-2-0-260128:default:non_video_in:silent',null,null,'replicate_docs','https://replicate.com/bytedance/seedance-2.0',1.0,'per second','Direct BytePlus alias uses the Replicate 720p non-video-input rate.'),
    ('generate_freepik_video','veo-3.1-generate-001','Google Veo 3.1 no audio',350,'per_second',null,false,'veo','veo-3.1-generate-001:without_audio',null,null,'replicate_docs','https://replicate.com/google/veo-3.1',1.0,'per second','Replicate google/veo-3.1 without_audio rate $0.20/sec.'),
    ('generate_freepik_video','veo-3.1-generate-001','Google Veo 3.1 + audio',700,'per_second',null,true,'veo','veo-3.1-generate-001:with_audio',null,null,'replicate_docs','https://replicate.com/google/veo-3.1',1.0,'per second','Replicate google/veo-3.1 with_audio rate $0.40/sec.'),
    ('generate_freepik_video','veo-3.1-generate-preview','Google Veo 3.1 legacy no audio',350,'per_second',null,false,'veo','veo-3.1-generate-preview:without_audio',null,null,'replicate_docs','https://replicate.com/google/veo-3.1',1.0,'per second','Legacy alias for saved canvases.'),
    ('generate_freepik_video','veo-3.1-generate-preview','Google Veo 3.1 legacy + audio',700,'per_second',null,true,'veo','veo-3.1-generate-preview:with_audio',null,null,'replicate_docs','https://replicate.com/google/veo-3.1',1.0,'per second','Legacy alias for saved canvases.'),
    ('generate_freepik_video','wan2.1-vace-1.3b-runpod','Wan 2.1 VACE 1.3B on RunPod',900,'fixed',null,false,'runpod','wan2.1-vace-1.3b-runpod','480p',null,'official_docs','https://github.com/Wan-Video/Wan2.1',null,'per short VACE video job','Initial fixed MVP price for source video + mask video + reference image Wan VACE jobs.'),

    -- Text, speech, translation, subtitle, and prompt tools.
    ('chat_ai','google/gemini-3-pro-preview','Gemini 3 Pro Preview',100,'per_operation',null,false,'google','gemini-3-pro-preview',null,null,'official_docs','https://ai.google.dev/gemini-api/docs/gemini-3',null,'per operation','Workspace fixed-operation placeholder for prompt assistance.'),
    ('chat_ai','google/gemini-3.1-pro-preview','Gemini 3 Pro Preview legacy 3.1 alias',100,'per_operation',null,false,'google','gemini-3-pro-preview:legacy-3.1-alias',null,null,'legacy_alias','https://ai.google.dev/gemini-api/docs/gemini-3',null,'per operation','Legacy alias retained so saved canvases still price.'),
    ('chat_ai','google/gemini-3-flash-preview','Gemini 3 Flash Preview',20,'per_operation',null,false,'google','gemini-3-flash-preview',null,null,'master_pricing_sheet','https://ai.google.dev/gemini-api/docs/pricing',null,'per operation','Workspace fixed-operation placeholder for lightweight prompt assistance.'),
    ('text_to_speech','gemini-3.1-flash-tts-preview','Gemini 3.1 Flash Preview TTS / 1K chars',50,'per_1k_chars',null,false,'google','gemini-3.1-flash-tts-preview','text','flash','official_docs_estimate','https://ai.google.dev/gemini-api/docs/speech-generation',null,'per 1K chars','Runtime bills by text length until audio-token metering is implemented.'),
    ('text_to_speech','gemini-2.5-flash-preview-tts','Gemini 2.5 Flash Preview TTS / 1K chars',50,'per_1k_chars',null,false,'google','gemini-2.5-flash-preview-tts','text','flash','official_docs_estimate','https://ai.google.dev/gemini-api/docs/pricing',null,'per 1K chars','Runtime bills by text length until audio-token metering is implemented.'),
    ('text_to_speech','gemini-2.5-pro-preview-tts','Gemini 2.5 Pro Preview TTS / 1K chars',100,'per_1k_chars',null,false,'google','gemini-2.5-pro-preview-tts','text','pro','official_docs_estimate','https://ai.google.dev/gemini-api/docs/pricing',null,'per 1K chars','Runtime bills by text length until audio-token metering is implemented.'),
    ('text_to_speech','elevenlabs-multilingual-v2','ElevenLabs Multilingual v2 / 1K chars',175,'per_1k_chars',null,false,'elevenlabs','eleven_multilingual_v2','text','multilingual-v2','official_docs_estimate','https://elevenlabs.io/docs/models',null,'per 1K chars','Estimated from ElevenLabs 1 credit per character and normalized through Workspace credits.'),
    ('text_to_speech','eleven_multilingual_v2','ElevenLabs Multilingual v2 API alias / 1K chars',175,'per_1k_chars',null,false,'elevenlabs','eleven_multilingual_v2','text','multilingual-v2','official_docs_estimate','https://elevenlabs.io/docs/models',null,'per 1K chars','Runtime alias for the official ElevenLabs model_id.'),
    ('text_to_speech','elevenlabs-turbo-v2-5','ElevenLabs Turbo v2.5 / 1K chars',88,'per_1k_chars',null,false,'elevenlabs','eleven_turbo_v2_5','text','turbo-v2.5','official_docs_estimate','https://elevenlabs.io/docs/models',null,'per 1K chars','Estimated from ElevenLabs 0.5 credit per character and normalized through Workspace credits.'),
    ('text_to_speech','eleven_turbo_v2_5','ElevenLabs Turbo v2.5 API alias / 1K chars',88,'per_1k_chars',null,false,'elevenlabs','eleven_turbo_v2_5','text','turbo-v2.5','official_docs_estimate','https://elevenlabs.io/docs/models',null,'per 1K chars','Runtime alias for the official ElevenLabs model_id.'),
    ('text_to_speech','google-tts-studio','Google Cloud TTS Studio / 1K chars',280,'per_1k_chars',null,false,'google','google-tts-studio','text','studio','official_docs','https://cloud.google.com/text-to-speech/pricing',null,'per 1K chars','Google Cloud Studio voice pricing normalized to Workspace credits.'),
    ('text_to_speech','google-tts-neural2','Google Cloud TTS Neural2 / 1K chars',28,'per_1k_chars',null,false,'google','google-tts-neural2','text','neural2','official_docs','https://cloud.google.com/text-to-speech/pricing',null,'per 1K chars','Google Cloud Neural2 voice pricing normalized to Workspace credits.'),
    ('text_to_speech','google-tts-wavenet','Google Cloud TTS WaveNet / 1K chars',7,'per_1k_chars',null,false,'google','google-tts-wavenet','text','wavenet','official_docs','https://cloud.google.com/text-to-speech/pricing',null,'per 1K chars','Google Cloud WaveNet voice pricing normalized to Workspace credits.'),
    ('text_to_speech','google-tts-chirp3-hd','Google Cloud TTS Chirp 3 HD / 1K chars',53,'per_1k_chars',null,false,'google','google-tts-chirp3-hd','text','chirp3-hd','official_docs','https://cloud.google.com/text-to-speech/pricing',null,'per 1K chars','Google Cloud Chirp 3 HD voice pricing normalized to Workspace credits.'),
    ('voice_translate','elevenlabs-dubbing-voice-clone','ElevenLabs Dubbing Voice Clone / min',1610,'per_minute',null,false,'elevenlabs','dubbing:voice-clone','media','voice-clone','official_docs_estimate','https://help.elevenlabs.io/hc/en-us/articles/23338815703697-How-much-does-Dubbing-cost',null,'per media minute','Runtime bills by source media duration and auto-returns MP3/MP4 based on input.'),
    ('auto_subtitle','auto-suptitle-whisper','Auto Subtitle / min',70,'per_minute',null,false,'openai','gpt-4o-transcribe+whisper-1+gpt-normalize','media','word-timestamps','official_docs_estimate','https://developers.openai.com/api/docs/models/gpt-4o-transcribe',null,'per source minute','Conservative per-minute floor for transcription, timing, normalization, and render.'),
    ('video_to_prompt','gemini-video-understanding','Video to Prompt (Gemini)',50,'per_operation',null,false,'google','gemini-video-understanding',null,null,'master_pricing_sheet','https://ai.google.dev/gemini-api/docs/pricing',null,'per analysis','Fixed short/medium analysis price.'),
    ('video_to_prompt','gemini-3-pro-preview','Video to Prompt (Gemini 3 Pro)',50,'per_operation',null,false,'google','gemini-3-pro-preview:video',null,null,'official_docs','https://ai.google.dev/gemini-api/docs/gemini-3',null,'per analysis','Matches workspace Video to Prompt model selector.'),
    ('video_to_prompt','gemini-3.1-pro-preview','Video to Prompt (Gemini 3 Pro legacy 3.1 alias)',50,'per_operation',null,false,'google','gemini-3-pro-preview:video:legacy-3.1-alias',null,null,'legacy_alias','https://ai.google.dev/gemini-api/docs/gemini-3',null,'per analysis','Legacy alias retained so saved canvases still price.'),
    ('video_to_prompt','gemini-3-flash-preview','Video to Prompt (Gemini 3 Flash)',50,'per_operation',null,false,'google','gemini-3-flash-preview:video',null,null,'master_pricing_sheet','https://ai.google.dev/gemini-api/docs/pricing',null,'per analysis','Matches workspace Video to Prompt model selector.'),
    ('merge_audio_video','shotstack','Merge Audio + Video (Shotstack short clip)',100,'per_operation',null,false,'shotstack','shotstack:short-op',null,null,'master_pricing_sheet',null,null,'per short operation','Fixed short clip price until runtime tracks media duration per minute.'),
    ('merge_audio_video','shotstack:per-minute','Merge Audio + Video (Shotstack per minute)',500,'per_minute',null,false,'shotstack','shotstack:per-minute',null,null,'master_pricing_sheet',null,null,'per minute','Shotstack PAYG/subscription blended recommendation.'),

    -- 3D and utility generators.
    ('model_3d','tripo3d-import','Tripo3D Import Model',1,'per_operation',null,false,'tripo3d','import_model','model','import','official_docs','https://docs.tripo3d.ai/model-generation/import-model.html',null,'per import','Tripo lists import_model as free; Workspace charges a 1-credit infrastructure floor.'),
    ('model_3d','tripo3d-prerigcheck','Tripo3D Pre-Rig Check',1,'per_operation',null,false,'tripo3d','animate_prerigcheck','model','check','official_docs','https://docs.tripo3d.ai/animation/pre-rig-check-v2-0-20250506.html',null,'per check','Tripo lists pre-rig check as free; Workspace charges a 1-credit infrastructure floor.'),
    ('model_3d','tripo3d-rig','Tripo3D Auto Rig',250,'per_operation',null,false,'tripo3d','animate_rig','model','rig','official_docs','https://docs.tripo3d.ai/animation/rig-v2-5-20260210.html',null,'per rig','Official Tripo rig cost is 25 provider credits; Workspace uses the existing approximate 10x provider-credit convention.'),
    ('model_3d','tripo3d-retarget','Tripo3D Animation Retarget',100,'per_operation',null,false,'tripo3d','animate_retarget','model','animation','official_docs','https://docs.tripo3d.ai/animation/retarget.html',null,'per animation task','Official Tripo retarget cost is 10 provider credits per animation.'),
    ('model_3d','tripo3d-conversion','Tripo3D Export Conversion',50,'per_operation',null,false,'tripo3d','convert_model','model','export','official_docs','https://docs.tripo3d.ai/export/conversion.html',null,'per conversion','Official Tripo conversion base cost is 5 provider credits plus optional surcharges.'),
    ('model_3d','tripo3d-v3.1','Tripo3D v3.1 Detailed',900,'per_operation',null,false,'tripo3d','tripo3d-v3.1','model','detailed','master_pricing_sheet','https://www.tripo3d.ai/',null,'per model','Master pricing sheet: detailed/high-quality generation approx 900 credits/model.'),
    ('model_3d','tripo3d-p1','Tripo3D P1',850,'per_operation',null,false,'tripo3d','tripo3d-p1','model','premium','master_pricing_sheet','https://www.tripo3d.ai/',null,'per model','Master pricing sheet: P1 approx 850 credits/model.'),
    ('model_3d','tripo3d-turbo','Tripo3D Turbo',500,'per_operation',null,false,'tripo3d','tripo3d-turbo','model','fast','master_pricing_sheet','https://www.tripo3d.ai/',null,'per model','Master pricing sheet: Turbo approx 500 credits/model.'),
    ('model_3d','tripo3d-v3.0','Tripo3D v3.0',500,'per_operation',null,false,'tripo3d','tripo3d-v3.0','model','standard','needs_provider_invoice',null,null,'per model','Emergency pricing floor aligned with Tripo3D Turbo until invoice/SKU rate is confirmed.'),
    ('model_3d','tripo3d-v2.5','Tripo3D v2.5',500,'per_operation',null,false,'tripo3d','tripo3d-v2.5','model','standard','needs_provider_invoice',null,null,'per model','Emergency pricing floor aligned with Tripo3D Turbo until invoice/SKU rate is confirmed.'),
    ('model_3d','hyper3d-gen2-260112','Hyper3D Gen 2',900,'per_operation',null,false,'hyper3d','hyper3d-gen2-260112','model','detailed','needs_provider_invoice',null,null,'per model','Emergency pricing floor aligned with detailed 3D generation until Hyper3D invoice/SKU data is reconciled.'),
    ('remove_background','freepik-remove-bg','Remove Background (Freepik/Magnific)',20,'per_operation',null,false,'freepik','freepik-remove-bg',null,null,'official_docs','https://docs.freepik.com/api-reference/remove-background/overview',null,'per image','Workspace remove_bg calls Freepik/Magnific remove-background; legacy saved nodes normalize to this row.'),
    ('generate_qwen_image','qwen-image-runpod','Qwen Image on RunPod',180,'per_operation',null,false,'runpod','qwen-image-runpod',null,null,'official_docs','https://docs.comfy.org/tutorials/image/qwen/qwen-image',null,'per image','MVP pricing for self-hosted Qwen Image on RunPod GPU.'),
    ('generate_qwen_image','qwen-image-edit-2511-runpod','Qwen Image Edit 2511 on RunPod',260,'per_operation',null,false,'runpod','qwen-image-edit-2511-runpod',null,null,'official_docs','https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit-2511',null,'per image edit','MVP pricing for Qwen Image Edit 2511 on RunPod GPU.')
)
insert into public.credit_costs (
  feature,
  model,
  label,
  cost,
  pricing_type,
  duration_seconds,
  has_audio,
  provider,
  price_key,
  resolution,
  quality,
  source,
  source_url,
  source_ratio,
  provider_unit,
  notes
)
select
  feature,
  model,
  label,
  cost::integer,
  pricing_type,
  duration_seconds::integer,
  has_audio::boolean,
  provider,
  price_key,
  resolution,
  quality,
  source,
  source_url,
  source_ratio::numeric,
  provider_unit,
  notes
from rows
on conflict (feature, COALESCE(model, '__default__'), COALESCE(duration_seconds, 0), COALESCE(has_audio, false))
do update set
  label = excluded.label,
  cost = excluded.cost,
  pricing_type = excluded.pricing_type,
  duration_seconds = excluded.duration_seconds,
  has_audio = excluded.has_audio,
  provider = excluded.provider,
  price_key = excluded.price_key,
  resolution = excluded.resolution,
  quality = excluded.quality,
  source = excluded.source,
  source_url = excluded.source_url,
  source_ratio = excluded.source_ratio,
  provider_unit = excluded.provider_unit,
  notes = excluded.notes,
  updated_at = now();
