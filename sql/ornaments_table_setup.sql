-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Ornaments table for kathakali ornaments information
CREATE TABLE IF NOT EXISTS ornaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path_d TEXT NOT NULL,
  tooltip_position JSONB NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT,
  metadata JSONB,
  embedding VECTOR(384),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Helpful indexes for ornaments
CREATE INDEX IF NOT EXISTS idx_ornaments_name 
  ON ornaments (name);

CREATE INDEX IF NOT EXISTS idx_ornaments_embedding 
  ON ornaments USING ivfflat (embedding vector_cosine_ops);

-- Full text search index
CREATE INDEX IF NOT EXISTS idx_ornaments_search
  ON ornaments USING gin(to_tsvector('english', name || ' ' || description));

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update the updated_at column
DROP TRIGGER IF EXISTS update_ornaments_updated_at ON ornaments;
CREATE TRIGGER update_ornaments_updated_at
  BEFORE UPDATE ON ornaments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert sample ornaments data
-- Function for vector similarity search
CREATE OR REPLACE FUNCTION match_ornaments(
  query_embedding vector(384),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id TEXT,
  name TEXT,
  path_d TEXT,
  tooltip_position JSONB,
  description TEXT,
  image_url TEXT,
  metadata JSONB,
  similarity float
)
LANGUAGE SQL STABLE
AS $$
  SELECT 
    ornaments.id,
    ornaments.name,
    ornaments.path_d,
    ornaments.tooltip_position,
    ornaments.description,
    ornaments.image_url,
    ornaments.metadata,
    1 - (ornaments.embedding <=> query_embedding) AS similarity
  FROM ornaments
  WHERE ornaments.embedding IS NOT NULL
  AND 1 - (ornaments.embedding <=> query_embedding) > match_threshold
  ORDER BY ornaments.embedding <=> query_embedding
  LIMIT match_count;
$$;

INSERT INTO ornaments (id, name, path_d, tooltip_position, description, image_url, metadata) VALUES
('kireedam', 'Kireedam', 'M 374.2 421.0 L 330.2 383.2 L 299.2 340.2 L 287.2 296.2 L 291.2 232.2 L 324.2 173.2 L 375.2 134.2 L 442.2 118.2 L 472.2 120.0 L 507.2 134.0 L 543.2 158.0 L 573.2 187.0 L 592.2 240.0 L 599.2 288.0 L 583.2 346.0 L 548.2 391.0 L 499.2 424.0 L 493.2 413.0 L 377.2 411.0 L 375.2 416.0 Z', '{"top": "10%", "left": "88%"}', 'Headdress (Crown) of Kathi. 2 pieces carved wood: disc & crown', '/assets/images/kathakali-ornaments/kireedam.png', '{"type": "headdress", "material": "carved wood", "pieces": 2}'),
('thoda', 'Thoda', 'M 363.2 366.0 L 345.2 374.0 L 343.2 394.0 L 359.2 410.0 L 375.2 408.0 L 382.2 389.0 L 376.2 372.0 L 364.2 364.0 Z', '{"top": "20%", "left": "93%"}', 'Ear Ornaments. Worn with Kireedam headdress. Larger than Chevippuvu', '/assets/images/kathakali-ornaments/thoda.png', '{"type": "ear_ornament", "size": "large", "worn_with": "kireedam"}'),
('chevippuvu', 'Chevippuvu', 'M 357.2 432.6 L 346.2 438.6 L 338.2 451.6 L 342.2 469.6 L 355.2 478.6 L 376.2 471.6 L 384.2 451.6 L 369.2 432.6 L 359.2 432.6 Z', '{"top": "30%", "left": "88%"}', 'Ear Ornaments. Attached to headband. Smaller than Thoda', '/assets/images/kathakali-ornaments/chevippuvu.png', '{"type": "ear_ornament", "size": "small", "attachment": "headband"}'),
('chutti', 'Chutti', 'M 383.2 468.2 L 357.2 476.2 L 342.2 497.2 L 352.2 518.2 L 413.2 547.2 L 471.2 539.2 L 522.2 514.2 L 528.2 502.2 L 522.2 483.2 L 487.2 468.2 L 485.2 508.2 L 479.2 518.2 L 430.2 537.2 L 387.2 515.2 L 383.2 468.2 Z', '{"top": "30%", "left": "88%"}', 'White facial ridges made from a mixture of rice paste and lime. Highlights the facial make-up and crucial for distinguishing characters and their personalities. Besides the face framing chutti, Kathi also wears white, knob-like chutti flowers on the nose and between the eyebrows', '/assets/images/kathakali-ornaments/kathichutti.png', '{"type": "facial_ornament", "material": "rice paste and lime", "color": "white", "purpose": "character distinction"}'),
('kazhuthunada', 'Kazhuthu nada', 'M 393.2 549.0 L 395.2 562.0 L 427.2 574.0 L 462.2 569.0 L 472.2 564.0 L 476.2 550.0 L 452.2 559.0 L 432.2 563.0 L 409.2 557.0 L 393.2 547.0 Z', '{"top": "32%", "left": "88%"}', 'Choker made of black cotton and red wool over cotton tape. Worn over kazhuttartam (necklace) to keep in place', '/assets/images/kathakali-ornaments/kazhuthunada.png', '{"type": "choker", "materials": ["black cotton", "red wool", "cotton tape"], "worn_with": "kazhuttaram"}'),
('kazhuttaram', 'Kazhuttaram', 'M 395.2 567.8 L 399.2 588.8 L 380.2 688.8 L 386.2 763.8 L 419.2 797.8 L 439.2 798.8 L 462.2 749.8 L 481.2 689.8 L 469.2 613.8 L 470.2 596.8 L 466.2 582.8 L 473.2 563.8 L 448.2 569.8 L 425.2 570.8 L 394.2 561.8 Z', '{"top": "22%", "left": "95%"}', 'Necklace made of plastic and metal gold toned beads with two red wool pompoms', '/assets/images/kathakali-ornaments/kazhuttaram.png', '{"type": "necklace", "materials": ["plastic beads", "metal beads", "red wool"], "decorations": "pompoms"}'),
('paruttikkaimani', 'Paruttikkaimani', 'M 223.2 648.8 L 227.2 665.8 L 238.2 672.8 L 254.2 657.8 L 282.2 658.8 L 319.2 678.8 L 331.2 654.8 L 294.2 640.8 L 254.2 633.8 L 223.2 647.8 Z', '{"top": "32%", "left": "88%"}', 'Men''s Upper Arm Band made of wooden beads and baubles with gilt foil. Tied below tolputtu (epaulettes) at bicep with all three strings to outside of arm', '/assets/images/kathakali-ornaments/paruttikkaimani.png', '{"type": "arm_band", "gender": "men", "materials": ["wooden beads", "gilt foil"], "position": "bicep"}'),
('tolputtu', 'Tolputtu', 'M 283.2 588.8 L 320.2 579.8 L 329.2 588.8 L 300.2 645.8 L 282.2 635.8 L 243.2 638.8 L 280.2 590.8 Z', '{"top": "27%", "left": "88%"}', 'Epaulettes made of 6 pieces carved wood. Cotton cords tied around body & bicep', '/assets/images/kathakali-ornaments/tolputtu.png', '{"type": "epaulette", "material": "carved wood", "pieces": 6, "fastening": "cotton cords"}'),
('kuralaram', 'Kuralaram', 'M 371.2 772.8 L 368.2 790.8 L 379.2 804.8 L 419.2 814.8 L 471.2 806.8 L 491.2 810.8 L 513.2 803.8 L 520.2 786.8 L 517.2 775.8 L 474.2 780.8 L 411.2 777.8 L 373.2 766.8 L 371.2 771.8 Z', '{"top": "25%", "left": "88%"}', 'Men''s breastplate made of 10 pieces carved wood. Neck bound with stitched cotton tape', '/assets/images/kathakali-ornaments/kuralaram.png', '{"type": "breastplate", "gender": "men", "material": "carved wood", "pieces": 10}'),
('uttariya', 'Uttariya', 'M 376.2 535.8 L 360.2 548.8 L 350.2 566.8 L 336.2 577.8 L 310.2 705.8 L 167.2 890.8 L 137.2 912.8 L 84.2 981.8 L 69.2 990.8 L 62.2 1002.8 L 40.2 997.8 L 27.2 1007.8 L 11.2 1010.8 L 0.2 1022.8 L 0.2 1126.8 L 16.2 1122.8 L 36.2 1138.8 L 91.2 1039.8 L 83.2 1023.8 L 98.2 997.8 L 112.2 993.8 L 152.2 938.8 L 183.2 926.8 L 287.2 832.8 L 256.2 916.8 L 259.2 942.8 L 246.2 958.8 L 246.2 971.8 L 211.2 970.8 L 203.2 990.8 L 186.2 1018.8 L 151.2 1087.8 L 190.2 1125.8 L 220.2 1124.8 L 283.2 1115.8 L 346.2 1131.8 L 409.2 1112.8 L 403.2 1088.8 L 429.2 1070.8 L 438.2 1047.8 L 378.2 965.8 L 362.2 969.8 L 347.2 945.8 L 357.2 922.8 L 356.2 770.8 L 338.2 709.8 L 360.2 586.8 L 372.2 567.8 L 374.2 533.8 Z', '{"top": "42%", "left": "93%"}', 'Neck streamers/scarves made of white cotton, 36"x78", tied at center and third marks; striped area at edge tied off with folded/pleated self ruffles and stuffed full at stripes plus smell ball above', '/assets/images/kathakali-ornaments/uttariya.png', '{"type": "scarf", "material": "white cotton", "dimensions": "36x78 inches", "attachment": "tied"}'),
('kastakatakam', 'Kastakatakam', 'M 356.2 693.8 L 359.2 718.8 L 372.2 724.8 L 378.2 753.8 L 372.2 770.8 L 376.2 783.8 L 386.2 790.8 L 407.2 783.8 L 426.2 777.8 L 417.2 750.8 L 406.2 745.8 L 395.2 711.8 L 408.2 692.8 L 408.2 677.8 L 393.2 678.8 L 381.2 686.8 L 357.2 690.8 Z', '{"top": "20%", "left": "0%"}', 'Wrist decorations made of green wool tassels with red cord ties. Tied to wrist below Kalases (bracelet cuffs)', '/assets/images/kathakali-ornaments/kastakatakam.png', '{"type": "wrist_decoration", "materials": ["green wool", "red cord"], "worn_below": "kalases"}'),
('kalases', 'Kalases', 'M 326.2 712.8 L 327.2 749.8 L 343.2 778.8 L 382.2 760.8 L 375.2 745.8 L 371.2 723.8 L 359.2 717.8 L 354.2 706.8 L 327.2 710.8 Z', '{"top": "20%", "left": "0%"}', 'Bracelet cuffs made of gilt foil with strings of silver toned beads', '/assets/images/kathakali-ornaments/kalases.png', '{"type": "bracelet_cuff", "materials": ["gilt foil", "silver toned beads"]}'),
('pattuval', 'Pattu Val', 'M 377.2 537.6 L 371.2 571.6 L 357.2 616.6 L 341.2 707.6 L 355.2 711.6 L 355.2 695.6 L 373.2 684.6 L 380.2 689.6 L 399.2 588.6 L 395.2 574.6 L 394.2 550.6 L 379.2 535.6 Z', '{"top": "32%", "left": "88%"}', 'Side streamers made of red panne with gold pinstripe, gold brocaded ribbon trims, wool yarn fringe, straight grain cotton saffron binding, red cotton backing. Worn over Men''s Kathakali Skirt', '/assets/images/kathakali-ornaments/pattuval.png', '{"type": "side_streamer", "materials": ["red panne", "gold trim", "wool fringe", "cotton"], "worn_over": "kathakali skirt"}'),
('patiarannanam', 'Patiarannanam', 'M 315.2 829.4 L 371.2 962.4 L 398.2 992.4 L 413.2 998.0 L 404.2 1016.0 L 447.2 1025.0 L 448.2 1014.0 L 438.2 1001.0 L 492.2 967.0 L 506.2 953.0 L 556.2 819.0 L 528.2 821.0 L 486.2 829.0 L 444.2 840.0 L 390.2 841.0 L 346.2 824.0 L 325.2 801.0 L 314.2 828.0 Z', '{"top": "37%", "left": "88%"}', 'Men''s belt decorated with gilt foil, plastic jewels and red wool felt. Tied with white cotton cord', '/assets/images/kathakali-ornaments/patiarannanam.png', '{"type": "belt", "gender": "men", "decorations": ["gilt foil", "plastic jewels", "red wool felt"], "fastening": "white cotton cord"}'),
('ottanakku', 'Ottanakku', 'M 378.2 900.2 L 370.2 963.2 L 381.2 1116.2 L 385.2 1152.2 L 399.2 1186.2 L 416.2 1196.2 L 426.2 1200.2 L 414.2 1213.2 L 416.2 1233.2 L 432.2 1240.2 L 445.2 1228.2 L 449.2 1208.2 L 438.2 1198.2 L 470.2 1188.2 L 494.2 1129.2 L 499.2 1052.2 L 501.2 941.2 L 485.2 893.2 L 460.2 906.2 L 400.2 909.2 L 379.2 897.2 Z', '{"top": "18%", "left": "92%"}', 'Apron made of red wool tassel with wooden bell shaped topper decorated in gilt foil. Chrome decoration with silver tone beads. Red cotton cord to tie around waist', '/assets/images/kathakali-ornaments/ottanakku.png', '{"type": "apron", "materials": ["red wool", "wooden bell", "gilt foil", "chrome", "silver beads"], "fastening": "red cotton cord"}'),
('chuttituni', 'Chuttituni', 'M 367.2 434.0 L 377.2 419.0 L 469.2 419.0 L 495.2 429.0 L 501.2 439.0 L 485.2 457.0 L 464.2 438.0 L 408.2 438.0 L 395.2 438.0 L 380.2 451.0 L 366.2 434.0 Z', '{"top": "12%", "left": "88%"}', 'Headbands made of red wool felt with black cotton backing and rice paste décor', '/assets/images/kathakali-ornaments/chuttituni.png', '{"type": "headband", "materials": ["red wool felt", "black cotton", "rice paste"], "purpose": "decorative base"}')
ON CONFLICT (id) DO NOTHING;