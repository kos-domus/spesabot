-- Migration 011 introduced refresh_product_tags(since_hours INTEGER DEFAULT 6)
-- as a second overload instead of replacing the original no-arg function from
-- migration 003. Postgres then refused to resolve `SELECT refresh_product_tags()`
-- because two candidates matched. Drop both, recreate only the parametrized
-- version (the default keeps the no-arg call-site working).

DROP FUNCTION IF EXISTS refresh_product_tags();
DROP FUNCTION IF EXISTS refresh_product_tags(INTEGER);

CREATE OR REPLACE FUNCTION refresh_product_tags(since_hours INTEGER DEFAULT 6) RETURNS void AS $$
DECLARE
  cutoff TIMESTAMPTZ;
BEGIN
  cutoff := CASE WHEN since_hours <= 0
                 THEN '1970-01-01'::timestamptz
                 ELSE now() - (since_hours || ' hours')::interval
            END;

  UPDATE product_skus SET tags = '{}' WHERE updated_at >= cutoff;

  UPDATE product_skus SET tags = array_append(tags, 'senza-lattosio')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%senza lattosio%' OR raw_name ILIKE '%delattosato%'
           OR raw_name ILIKE '%lactose free%' OR raw_name ILIKE '%s.lattosio%');

  UPDATE product_skus SET tags = array_append(tags, 'senza-glutine')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%senza glutine%' OR raw_name ILIKE '%gluten free%'
           OR raw_name ILIKE '%s.glutine%');

  UPDATE product_skus SET tags = array_append(tags, 'integrale')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%integrale%' OR raw_name ILIKE '%integrali%');

  UPDATE product_skus SET tags = array_append(tags, 'bio')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%biologic%' OR raw_name ILIKE '% bio %'
           OR raw_name ILIKE '%bio %' OR raw_name ILIKE '% bio');

  UPDATE product_skus SET tags = array_append(tags, 'vegano')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%vegan%' OR raw_name ILIKE '%vegetale%'
           OR raw_name ILIKE '%plant based%' OR raw_name ILIKE '%plant-based%');

  UPDATE product_skus SET tags = array_append(tags, 'prima-infanzia')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%neonato%' OR raw_name ILIKE '%bimbo%'
           OR raw_name ILIKE '%pannolin%' OR raw_name ILIKE '%omogenizz%'
           OR raw_name ILIKE '%baby%' OR raw_name ILIKE '%infanzia%'
           OR raw_name ILIKE '%crescita%');

  UPDATE product_skus SET tags = array_append(tags, 'proteico')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%proteic%' OR raw_name ILIKE '%protein%'
           OR raw_name ILIKE '%high protein%');

  UPDATE product_skus SET tags = array_append(tags, 'surgelati')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%surgelat%' OR raw_name ILIKE '%congelat%'
           OR raw_name ILIKE '%frozen%');

  UPDATE product_skus SET tags = array_append(tags, 'cura-casa')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%detersivo%' OR raw_name ILIKE '%detergente%'
           OR raw_name ILIKE '%ammorbidente%' OR raw_name ILIKE '%sgrassator%'
           OR raw_name ILIKE '%candeggina%' OR raw_name ILIKE '%anticalcar%'
           OR raw_name ILIKE '%lavastoviglie%' OR raw_name ILIKE '%pavimenti%'
           OR raw_name ILIKE '%carta igienica%' OR raw_name ILIKE '%scottex%'
           OR raw_name ILIKE '%sacchetti%');

  UPDATE product_skus SET tags = array_append(tags, 'cura-persona')
    WHERE updated_at >= cutoff
      AND (raw_name ILIKE '%shampoo%' OR raw_name ILIKE '%balsamo%'
           OR raw_name ILIKE '%bagnoschiuma%' OR raw_name ILIKE '%dentifricio%'
           OR raw_name ILIKE '%doccia%' OR raw_name ILIKE '%crema%'
           OR raw_name ILIKE '%deodorante%' OR raw_name ILIKE '%rasoio%'
           OR raw_name ILIKE '%assorbent%' OR raw_name ILIKE '%sapone%');

  UPDATE product_skus
    SET normalized_name = lower(regexp_replace(trim(raw_name), '\s+', ' ', 'g'))
    WHERE updated_at >= cutoff
      AND (normalized_name IS NULL OR normalized_name = '');

  UPDATE product_skus
    SET search_vector = to_tsvector('italian',
      coalesce(raw_name, '') || ' ' || coalesce(brand, '')
    )
    WHERE updated_at >= cutoff;
END;
$$ LANGUAGE plpgsql;
