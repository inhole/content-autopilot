-- Musinsa rows collected before this migration came from influencer.musinsa.com (a different,
-- login-only creator-campaign system), not from the public 체험단 list on musinsa.com/preuser.
-- Their ids and links never matched the real preuser events, so they are removed; the collector
-- now reads the public preuser API and re-creates the right rows. campaign_reminders cascade.
-- Only source 'musinsa' is touched, never 'kakao-gift'.
delete from campaigns where source = 'musinsa';
