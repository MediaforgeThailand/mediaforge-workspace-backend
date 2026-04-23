
-- Recover flow_nodes from settings.graph for Cat Face (4e1d0315)
-- Only runs if the flow exists (safe for clean schema resets)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.flows WHERE id = '4e1d0315-e9a9-46d5-90b4-e815e0246b52') THEN
    INSERT INTO flow_nodes (id, flow_id, node_type, label, position_x, position_y, sort_order, config)
    VALUES
      ('ef5656d4-c737-4470-a620-219667ec5758', '4e1d0315-e9a9-46d5-90b4-e815e0246b52', 'input/image', 'freepik__-texture-__19167', -165, 315, 0,
       '{"fieldType":"image","accept":"image/*","creatorAsset":true,"fieldLabel":"freepik__-texture-__19167","fileName":"freepik__-texture-__19167.png","nodeName":"Image1","storagePath":"fb4de7e2-9f6e-459b-bb1b-464f6ae14bea/ef5656d4-c737-4470-a620-219667ec5758.png","required":true,"connections":[]}'::jsonb),
      ('366f3b98-5226-43d6-aa11-574aec442954', '4e1d0315-e9a9-46d5-90b4-e815e0246b52', 'ai/banana_pro', 'Banana Pro (Image Gen)', 255, 405, 1,
       '{"params":{"model":"nano-banana-2","prompt":"เปลี่ยนส่วนหัวของคนในภาพ"},"exposed":{"model":true,"prompt":false},"connections":[{"source":"ef5656d4-c737-4470-a620-219667ec5758","targetHandle":"ref_image"},{"source":"a4cb1519-d821-4700-9b3c-72ee802b4b23","targetHandle":"ref_image"}]}'::jsonb),
      ('7d2f9a38-0d78-48ad-a265-faa6f2e70cd5', '4e1d0315-e9a9-46d5-90b4-e815e0246b52', 'output/media', 'Output', 675, 375, 2,
       '{"outputType":"video","connections":[{"source":"366f3b98-5226-43d6-aa11-574aec442954","sourceHandle":"image"}]}'::jsonb),
      ('a4cb1519-d821-4700-9b3c-72ee802b4b23', '4e1d0315-e9a9-46d5-90b4-e815e0246b52', 'input/image', 'freepik__text-to-image__48899', -135, 615, 3,
       '{"fieldType":"image","accept":"image/*","creatorAsset":true,"fieldLabel":"freepik__text-to-image__48899","fileName":"freepik__text-to-image__48899.png","nodeName":"image2","storagePath":"fb4de7e2-9f6e-459b-bb1b-464f6ae14bea/a4cb1519-d821-4700-9b3c-72ee802b4b23.png","required":true,"connections":[]}'::jsonb),
      ('7fc1060f-c927-4d39-b49b-fbdbfa8f06c0', '4e1d0315-e9a9-46d5-90b4-e815e0246b52', 'input/image', 'Image Upload', -555, 120, 4,
       '{"fieldType":"image","accept":"image/*","fieldLabel":"Upload your image","nodeName":"Image Upload","required":true,"connections":[]}'::jsonb),
      ('bf5fe5e0-2a5a-4f05-9cc9-1e017e83239a', '4e1d0315-e9a9-46d5-90b4-e815e0246b52', 'input/video', 'Video Upload', -675, 495, 5,
       '{"fieldType":"video","accept":"video/*","fieldLabel":"Upload your video","nodeName":"Video Upload","required":true,"connections":[]}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
