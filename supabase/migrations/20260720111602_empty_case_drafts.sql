-- A dispatcher must be able to open and save a case before the caller provides any
-- business details. All relation columns were already nullable; only these two
-- descriptive columns still prevented a genuinely empty draft.
alter table public.motorist_cases
  alter column source_type drop not null,
  alter column case_type drop not null;

comment on column public.motorist_cases.source_type is
  'Optional case source. NULL means the dispatcher has not established it yet.';

comment on column public.motorist_cases.case_type is
  'Optional free-form case type. NULL means the draft has not been classified yet.';
