-- The regen_seq a review draft was last written for (generation, or an owner edit). A draft request
-- is pending while regen_seq > draft_seq; the web console shows "writing the draft" from that.
alter table campaigns add column draft_seq int not null default 0;
update campaigns set draft_seq = regen_seq;
