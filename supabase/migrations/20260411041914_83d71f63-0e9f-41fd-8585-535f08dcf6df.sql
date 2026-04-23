
-- Recover flow_nodes from settings.graph for Draft 1 (90df2e2d)
-- Only runs if the flow exists (safe for clean schema resets)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.flows WHERE id = '90df2e2d-cc1a-4078-96e4-5ddb4a53a785') THEN
    INSERT INTO flow_nodes (id, flow_id, node_type, label, position_x, position_y, sort_order, config)
    VALUES
      ('438cafe3-8f68-460a-b3cf-daa2b62972b0', '90df2e2d-cc1a-4078-96e4-5ddb4a53a785', 'ai/banana_pro', 'Banana Pro (Image Gen)', 255, 405, 0,
       '{"params":{"model_name":"nano-banana-2","aspect_ratio":"Auto","prompt":""},"exposed":{},"connections":[{"source":"e212d6a3-d155-4830-ac02-a8450159ca3f","targetHandle":"ref_image"}]}'::jsonb),
      ('59100d6b-d88f-4b53-910d-bbca261aae4d', '90df2e2d-cc1a-4078-96e4-5ddb4a53a785', 'output/media', 'Output', 675, 375, 1,
       '{"outputType":"image","connections":[{"source":"438cafe3-8f68-460a-b3cf-daa2b62972b0","sourceHandle":"image"}]}'::jsonb),
      ('e212d6a3-d155-4830-ac02-a8450159ca3f', '90df2e2d-cc1a-4078-96e4-5ddb4a53a785', 'input/image', 'Image Upload', -200, 300, 2,
       '{"fieldType":"image","accept":"image/*","fieldLabel":"Upload your image","nodeName":"Image Upload","required":true,"connections":[]}'::jsonb),
      ('fc36b82f-2234-43b6-8ff2-d5295e2533f6', '90df2e2d-cc1a-4078-96e4-5ddb4a53a785', 'input/text', 'Text Input', -200, 100, 3,
       '{"fieldType":"text","fieldLabel":"Text","nodeName":"Man","connections":[]}'::jsonb),
      ('aec2eddc-a4d3-44e0-85e3-e8edb6da4b00', '90df2e2d-cc1a-4078-96e4-5ddb4a53a785', 'input/text', 'Text Input 2', -200, 500, 4,
       '{"fieldType":"text","fieldLabel":"Text","connections":[]}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
