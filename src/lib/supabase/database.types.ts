export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type Table<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

/** A read-only view: `Insert`/`Update` are `never`, so a write cannot compile. */
type View<Row> = {
  Row: Row;
  Relationships: [];
};

type Timestamp = string;
type ExternalVehicleSourceProvider = "commander" | "client_vehicle_db";
type TelephonyEnvironment = "production" | "development";
type RingMemberKind = "operator" | "external_number";

export type CallSessionState =
  | "received"
  | "greeting"
  | "ivr"
  | "ringing"
  | "talking"
  | "held"
  | "consulting"
  | "conference"
  | "parked"
  | "waiting"
  | "wrap_up"
  | "after_hours"
  | "callback_offered"
  | "missed"
  | "failed"
  | "ended";
export type CallLegRole = "customer" | "operator" | "consult" | "supervisor" | "external";
export type CallLegState = "initiated" | "ringing" | "answered" | "bridged" | "held" | "ended" | "failed";
export type RingAttemptResult =
  | "pending"
  | "offered"
  | "answered"
  | "no_answer"
  | "skipped_offline"
  | "busy"
  | "cancelled"
  | "failed";
export type OperatorPresenceStatus = "available" | "ringing" | "on_call" | "after_call_work" | "paused" | "offline";

export type Database = {
  public: {
    Tables: {
      motorist_organizations: Table<{
        id: string;
        slug: string;
        name: string;
        active: boolean;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_organization_profiles: Table<{
        id: string;
        organization_id: string;
        brand_name: string;
        default_locale: string;
        timezone: string;
        primary_phone: string | null;
        enabled_modules: string[];
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_organization_integrations: Table<{
        id: string;
        organization_id: string;
        provider: "telnyx" | "telnyx_sms" | "google_maps" | "fleet" | "ai" | "commander" | "client_vehicle_db";
        enabled: boolean;
        config: Json;
        secret_ref: string | null;
        status: "not_configured" | "configured" | "live" | "degraded" | "disabled";
        enabled_features: string[];
        base_url: string | null;
        last_success_at: Timestamp | null;
        last_error_at: Timestamp | null;
        last_error: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_profiles: Table<{
        id: string;
        organization_id: string;
        user_id: string | null;
        email: string | null;
        display_name: string;
        role: "dispatcher" | "senior_dispatcher" | "manager" | "admin";
        phone_extension: string | null;
        active: boolean;
        access_status: "not_invited" | "invited" | "active" | "disabled";
        invited_at: Timestamp | null;
        invite_last_sent_at: Timestamp | null;
        invited_by: string | null;
        password_set_at: Timestamp | null;
        access_disabled_at: Timestamp | null;
        access_disabled_by: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_auth_email_events: Table<{
        id: string;
        organization_id: string;
        profile_id: string | null;
        purpose: "invite" | "resend_invite" | "reset_password" | "forgot_password";
        recipient_email: string;
        provider: string;
        delivery_status: "requested" | "sent" | "failed" | "skipped";
        provider_message_id: string | null;
        idempotency_key: string | null;
        error_message: string | null;
        requested_by: string | null;
        request_ip: string | null;
        user_agent: string | null;
        metadata: Json;
        created_at: Timestamp;
      }>;
      motorist_operator_statuses: Table<{
        id: string;
        organization_id: string;
        profile_id: string;
        status: "available" | "ringing" | "on_call" | "after_call_work" | "working_case" | "paused" | "offline";
        reason: string | null;
        source: string;
        started_at: Timestamp;
        ended_at: Timestamp | null;
        created_at: Timestamp;
      }>;
      motorist_attendance_shift_templates: Table<{
        id: string;
        organization_id: string;
        label: string;
        kind: "fixed_8h" | "fixed_12h" | "custom";
        starts_at_local: string | null;
        ends_at_local: string | null;
        planned_minutes: number | null;
        color: string;
        active: boolean;
        sort_order: number;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_attendance_shifts: Table<{
        id: string;
        organization_id: string;
        profile_id: string;
        template_id: string | null;
        status: "draft" | "published" | "confirmed" | "declined" | "completed" | "cancelled" | "no_show";
        date_local: string;
        timezone: string;
        planned_start_at: Timestamp;
        planned_end_at: Timestamp;
        published_at: Timestamp | null;
        confirmed_at: Timestamp | null;
        declined_at: Timestamp | null;
        confirmation_note: string | null;
        notes: string | null;
        schedule_batch_id: string | null;
        batch_created_order: number | null;
        created_by: string | null;
        updated_by: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_attendance_sessions: Table<{
        id: string;
        organization_id: string;
        profile_id: string;
        shift_id: string | null;
        status: "open" | "closed" | "adjusted";
        source: "login" | "manual" | "system";
        started_at: Timestamp;
        ended_at: Timestamp | null;
        notes: string | null;
        created_by: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_attendance_employee_settings: Table<{
        id: string;
        organization_id: string;
        profile_id: string;
        default_available: boolean;
        vacation_days_per_year: number;
        max_weekly_minutes: number | null;
        notes: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_attendance_unavailability_requests: Table<{
        id: string;
        organization_id: string;
        profile_id: string;
        type: "vacation" | "unavailable" | "sick_leave" | "doctor" | "other";
        status: "draft" | "pending" | "approved" | "declined" | "cancelled";
        start_date_local: string;
        end_date_local: string;
        start_time_local: string | null;
        end_time_local: string | null;
        reason: string | null;
        decision_note: string | null;
        submitted_at: Timestamp | null;
        decided_at: Timestamp | null;
        decided_by: string | null;
        created_by: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_attendance_time_off_balances: Table<{
        id: string;
        organization_id: string;
        profile_id: string;
        year: number;
        vacation_days_total: number;
        vacation_days_used: number;
        vacation_days_pending: number;
        carried_over_days: number;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_attendance_schedule_batches: Table<{
        id: string;
        organization_id: string;
        name: string;
        status: "draft" | "published" | "cancelled";
        shift_mode: "fixed_8h" | "fixed_12h" | "custom";
        date_from_local: string;
        date_to_local: string;
        notes: string | null;
        created_by: string | null;
        published_at: Timestamp | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_telephony_lines: Table<{
        id: string;
        organization_id: string;
        provider: string;
        external_id: string | null;
        phone_number: string;
        label: string;
        telnyx_number_id: string | null;
        partner_name: string | null;
        ring_plan_id: string | null;
        ivr_menu_id: string | null;
        business_hours_id: string | null;
        environment: TelephonyEnvironment;
        active: boolean;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_telephony_queues: Table<{
        id: string;
        organization_id: string;
        provider: string;
        external_id: string;
        label: string;
        line_id: string | null;
        active: boolean;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_contacts: Table<{
        id: string;
        organization_id: string;
        name: string;
        phone: string | null;
        email: string | null;
        role: "client" | "assistance" | "branch" | "partner";
        notes: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_vehicles: Table<{
        id: string;
        organization_id: string;
        license_plate: string | null;
        vin: string | null;
        make: string | null;
        model: string | null;
        category: string | null;
        transmission: string | null;
        production_year: number | null;
        color: string | null;
        drive_type: string | null;
        weight_kg: number | null;
        is_driveable: boolean | null;
        notes: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_locations: Table<{
        id: string;
        organization_id: string;
        label: string;
        address: string;
        lat: number;
        lng: number;
        place_id: string | null;
        provider: string | null;
        confidence: number | null;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_branches: Table<{
        id: string;
        organization_id: string;
        name: string;
        address: string;
        phone: string | null;
        location_id: string | null;
        available_replacement_cars: number;
        active: boolean;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_partner_directory: Table<{
        id: string;
        organization_id: string;
        kind: "assistance" | "company";
        name: string;
        ico: string | null;
        phone: string | null;
        email: string | null;
        active: boolean;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_fleet_assets: Table<{
        id: string;
        organization_id: string;
        kind: "tow_truck" | "replacement_car";
        label: string;
        make: string | null;
        model: string | null;
        license_plate: string | null;
        vin: string | null;
        status: "available" | "reserved" | "rented" | "assigned" | "busy" | "service" | "offline";
        category:
          | "small_car"
          | "wagon"
          | "suv"
          | "van"
          | "personal_tow"
          | "van_tow"
          | "specialized_tow"
          | "heavy_tow"
          | null;
        weight_kg: number | null;
        branch_id: string | null;
        current_location_id: string | null;
        last_seen_at: Timestamp | null;
        notes: string | null;
        insurance_valid_until: string | null;
        highway_vignette_valid_until: string | null;
        technical_inspection_valid_until: string | null;
        emission_inspection_valid_until: string | null;
        occupied_from: Timestamp | null;
        occupied_until: Timestamp | null;
        occupancy_type: "reservation" | "rental" | "case_assignment" | null;
        occupancy_case_id: string | null;
        occupancy_note: string | null;
        assigned_driver_name: string | null;
        assigned_driver_phone: string | null;
        assigned_driver_status: "available" | "on_shift" | "on_call" | "off_shift" | null;
        tow_category: "personal" | "van" | "specialized" | "heavy" | null;
        capabilities: ("winch" | "low_garage" | "vans" | "trucks" | "immobile" | "crashed")[];
        source_system: string | null;
        external_id: string | null;
        location_source: string | null;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_fleet_provider_vehicles: Table<{
        id: string;
        organization_id: string;
        provider: string;
        external_id: string;
        label: string | null;
        license_plate: string | null;
        driver_name: string | null;
        unit_name: string | null;
        object_number: string | null;
        vehicle_type: string | null;
        online: boolean | null;
        disabled: boolean | null;
        linked_asset_id: string | null;
        latest_location_id: string | null;
        latest_position_at: Timestamp | null;
        latest_local_position_at: Timestamp | null;
        speed_kph: number | null;
        odometer_km: number | null;
        raw_catalog: Json;
        raw_position: Json;
        last_catalog_sync_at: Timestamp | null;
        last_position_sync_at: Timestamp | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_external_vehicle_records: Table<{
        id: string;
        organization_id: string;
        source_provider: ExternalVehicleSourceProvider;
        source_vehicle_id: string;
        normalized_license_plate: string | null;
        normalized_vin: string | null;
        label: string | null;
        make: string | null;
        model: string | null;
        kind_hint: "tow_truck" | "replacement_car" | null;
        source_active: boolean;
        source_deleted_at: Timestamp | null;
        latest_payload_snapshot: Json;
        first_seen_at: Timestamp;
        last_seen_at: Timestamp | null;
        last_imported_at: Timestamp;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_fleet_asset_links: Table<{
        id: string;
        organization_id: string;
        fleet_asset_id: string | null;
        external_vehicle_record_id: string;
        source_provider: ExternalVehicleSourceProvider;
        link_status: "candidate" | "confirmed" | "rejected";
        match_method: "vin" | "license_plate" | "manual" | "existing_external_id";
        match_confidence: number;
        confirmed_at: Timestamp | null;
        confirmed_by: string | null;
        rejected_at: Timestamp | null;
        rejected_by: string | null;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_fleet_current_positions: Table<{
        id: string;
        organization_id: string;
        external_vehicle_record_id: string;
        fleet_asset_id: string | null;
        source_provider: ExternalVehicleSourceProvider;
        source_vehicle_id: string;
        gps_time: Timestamp;
        lat: number;
        lng: number;
        speed_kmh: number | null;
        heading_degrees: number | null;
        ignition_on: boolean | null;
        odometer_m: number | null;
        payload_hash: string | null;
        latest_payload_snapshot: Json;
        received_at: Timestamp;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_fleet_position_samples: Table<{
        id: string;
        organization_id: string;
        external_vehicle_record_id: string;
        fleet_asset_id: string | null;
        source_provider: ExternalVehicleSourceProvider;
        source_vehicle_id: string;
        sampled_at: Timestamp;
        lat: number;
        lng: number;
        speed_kmh: number | null;
        heading_degrees: number | null;
        ignition_on: boolean | null;
        odometer_m: number | null;
        payload_hash: string | null;
        latest_payload_snapshot: Json;
        received_at: Timestamp;
        created_at: Timestamp;
      }>;
      motorist_fleet_trips: Table<{
        id: string;
        organization_id: string;
        external_vehicle_record_id: string;
        fleet_asset_id: string | null;
        source_provider: ExternalVehicleSourceProvider;
        source_vehicle_id: string;
        source_trip_id: string;
        status: "imported" | "details_unavailable" | "details_available";
        started_at: Timestamp;
        ended_at: Timestamp | null;
        start_lat: number | null;
        start_lng: number | null;
        stop_lat: number | null;
        stop_lng: number | null;
        start_address: string | null;
        stop_address: string | null;
        duration_s: number | null;
        distance_m: number | null;
        odometer_start_m: number | null;
        odometer_end_m: number | null;
        driver_id: string | null;
        driver_name: string | null;
        latest_payload_snapshot: Json;
        imported_at: Timestamp;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_fleet_replacement_occupancy: Table<{
        id: string;
        organization_id: string;
        captured_at: Timestamp;
        occupied_plates: string[];
        free_plates: string[];
        source: string;
        created_at: Timestamp;
      }>;
      motorist_fleet_sync_runs: Table<{
        id: string;
        organization_id: string;
        provider: ExternalVehicleSourceProvider;
        mode: "vehicles" | "positions" | "rides" | "full" | "occupancy";
        status: "running" | "success" | "partial" | "failed";
        started_at: Timestamp;
        finished_at: Timestamp | null;
        fetched_count: number;
        created_count: number;
        updated_count: number;
        linked_count: number;
        candidate_count: number;
        skipped_count: number;
        error_count: number;
        rate_limit_limit: number | null;
        rate_limit_remaining: number | null;
        rate_limit_reset: Timestamp | null;
        retry_after_seconds: number | null;
        endpoint_errors: Json;
        error_summary: string | null;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_cases: Table<{
        id: string;
        organization_id: string;
        case_number: string;
        status:
          | "new"
          | "triage"
          | "open"
          | "waiting_for_client"
          | "scheduled"
          | "assigned"
          | "dispatched"
          | "in_progress"
          | "waiting_for_docs"
          | "completed_assisted"
          | "completed_no_assistance"
          | "rejected"
          | "cancelled"
          | "futile_trip";
        priority: "urgent" | "high" | "normal" | "low";
        source_type: "client" | "assistance" | "samoplatca" | "partner" | "internal" | null;
        case_type: string | null;
        partner_id: string | null;
        owner_id: string | null;
        contact_id: string | null;
        vehicle_id: string | null;
        pickup_location_id: string | null;
        destination_location_id: string | null;
        selected_asset_id: string | null;
        assistance_reference: string | null;
        external_reference: string | null;
        summary: string | null;
        main_note: string | null;
        customer_details: Json;
        vehicle_details: Json;
        incident_details: Json;
        location_details: Json;
        replacement_vehicle_details: Json;
        payment_details: Json;
        closure_details: Json;
        attachments_metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
        closed_at: Timestamp | null;
        close_reason: string | null;
      }>;
      motorist_case_tasks: Table<{
        id: string;
        organization_id: string;
        case_id: string;
        title: string;
        assigned_to: string | null;
        due_at: Timestamp | null;
        status: "open" | "done" | "overdue";
        priority: "urgent" | "high" | "normal" | "low";
        kind: "callback" | "sms" | "dispatch" | "documents" | "billing" | "handover" | "other";
        created_by: string | null;
        completed_by: string | null;
        completed_at: Timestamp | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_task_reminders: Table<{
        id: string;
        organization_id: string;
        case_id: string;
        task_id: string;
        recipient_profile_id: string | null;
        visibility: "private" | "team";
        channels: string[];
        scheduled_for: Timestamp;
        status: "pending" | "processing" | "sent" | "cancelled" | "failed";
        dedupe_key: string;
        attempt_count: number;
        max_attempts: number;
        last_attempt_at: Timestamp | null;
        last_error: string | null;
        payload: Json;
        created_by: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_notifications: Table<{
        id: string;
        organization_id: string;
        case_id: string | null;
        task_id: string | null;
        reminder_id: string | null;
        recipient_profile_id: string | null;
        visibility: "private" | "team";
        kind: "task_due" | "task_overdue" | "handover" | "system";
        severity: "info" | "warning" | "urgent";
        title: string;
        body: string | null;
        status: "unread" | "read" | "archived";
        delivery_status: "in_app" | "email_sent" | "email_failed" | "failed";
        dedupe_key: string;
        read_at: Timestamp | null;
        archived_at: Timestamp | null;
        payload: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_case_events: Table<{
        id: string;
        organization_id: string;
        case_id: string;
        actor_profile_id: string | null;
        event_type: string;
        title: string;
        body: string | null;
        payload: Json;
        created_at: Timestamp;
      }>;
      motorist_location_share_links: Table<{
        id: string;
        organization_id: string;
        case_id: string;
        scope: "pickup_location";
        token_hash: string;
        status: "active" | "used" | "expired" | "revoked";
        expires_at: Timestamp;
        used_at: Timestamp | null;
        revoked_at: Timestamp | null;
        created_by: string | null;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_location_submissions: Table<{
        id: string;
        organization_id: string;
        case_id: string;
        link_id: string;
        location_id: string | null;
        lat: number;
        lng: number;
        accuracy_meters: number | null;
        source: "browser_geolocation";
        user_agent_hash: string | null;
        ip_hash: string | null;
        submitted_at: Timestamp;
        accepted: boolean;
        raw_payload_safe: Json;
        created_at: Timestamp;
      }>;
      motorist_calls: Table<{
        id: string;
        organization_id: string;
        provider: string;
        provider_session_id: string | null;
        provider_call_id: string | null;
        session_id: string | null;
        direction: "inbound" | "outbound" | "internal";
        status: "incoming" | "ringing_agent" | "answered" | "missed" | "abandoned_queue" | "outbound" | "ended" | "failed";
        end_reason: string | null;
        caller_number: string | null;
        caller_name: string | null;
        called_number: string | null;
        received_number: string | null;
        destination_number: string | null;
        line_id: string | null;
        queue_id: string | null;
        operator_id: string | null;
        case_id: string | null;
        started_at: Timestamp | null;
        answered_at: Timestamp | null;
        ended_at: Timestamp | null;
        wait_seconds: number | null;
        ring_seconds: number | null;
        duration_seconds: number | null;
        ring_group_id: string | null;
        operator_leg_id: string | null;
        recording_status: "not_requested" | "pending" | "available" | "failed" | "deleted";
        transcript_status: "not_requested" | "pending" | "complete" | "failed";
        summary: string | null;
        raw_payload: Json;
        raw_latest_payload: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_call_events: Table<{
        id: string;
        organization_id: string;
        call_id: string | null;
        provider: string;
        provider_session_id: string | null;
        event_type: string;
        event_fingerprint: string;
        payload: Json;
        raw_payload: Json;
        normalized_payload: Json;
        handled_status: "processed" | "ignored" | "failed" | "unknown";
        provider_created_at: Timestamp | null;
        provider_timestamp: Timestamp | null;
        received_at: Timestamp;
        created_at: Timestamp;
      }>;
      motorist_call_recordings: Table<{
        id: string;
        organization_id: string;
        call_id: string | null;
        provider: string;
        provider_session_id: string | null;
        provider_recording_id: string | null;
        storage_bucket: string | null;
        storage_path: string | null;
        mime_type: string | null;
        status: "pending" | "available" | "failed" | "deleted";
        duration_seconds: number | null;
        fetched_at: Timestamp | null;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_sms_messages: Table<{
        id: string;
        organization_id: string;
        provider: string;
        provider_message_id: string | null;
        case_id: string | null;
        call_id: string | null;
        to_number: string;
        from_label: string | null;
        from_sender: string | null;
        messaging_profile_id: string | null;
        direction: "outbound" | "inbound";
        status: "queued" | "sent" | "delivered" | "failed" | "received";
        status_detail: string | null;
        template_key: string | null;
        body: string;
        error: string | null;
        raw_payload: Json;
        idempotency_key: string | null;
        request_fingerprint: string | null;
        queued_at: Timestamp | null;
        next_attempt_at: Timestamp | null;
        last_attempt_at: Timestamp | null;
        locked_at: Timestamp | null;
        retry_count: number;
        sent_at: Timestamp | null;
        delivered_at: Timestamp | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_sms_attempts: Table<{
        id: string;
        organization_id: string;
        sms_message_id: string;
        provider: string;
        attempt_number: number;
        claim_id: string;
        idempotency_key: string;
        request_fingerprint: string;
        status: "queued" | "sending" | "accepted" | "failed" | "skipped";
        provider_status_code: number | null;
        provider_message_id: string | null;
        request_payload_safe: Json;
        provider_response_safe: Json;
        error_class: string | null;
        error: string | null;
        started_at: Timestamp | null;
        finished_at: Timestamp | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_route_estimates: Table<{
        id: string;
        organization_id: string;
        provider: string;
        origin_location_id: string | null;
        destination_location_id: string | null;
        distance_meters: number | null;
        duration_seconds: number | null;
        polyline: string | null;
        stale_after: Timestamp | null;
        provider_payload: Json;
        created_at: Timestamp;
      }>;
      motorist_integration_raw_events: Table<{
        id: string;
        organization_id: string;
        provider: string;
        channel: "rest" | "websocket" | "sms" | "internal";
        direction: "inbound" | "outbound";
        event_type: string;
        correlation_id: string | null;
        request_id: string | null;
        status_code: number | null;
        payload: Json;
        headers_safe: Json;
        received_at: Timestamp;
        processed_at: Timestamp | null;
        error: string | null;
        created_at: Timestamp;
      }>;
      motorist_call_transcripts: Table<{
        id: string;
        organization_id: string;
        call_id: string;
        recording_id: string | null;
        status: "pending" | "processing" | "complete" | "failed" | "restricted";
        language: string;
        transcript_text: string | null;
        speaker_segments: Json;
        summary: string | null;
        extracted_fields: Json;
        qa_score: number | null;
        model: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_audit_log: Table<{
        id: string;
        organization_id: string;
        actor_profile_id: string | null;
        action: string;
        entity_type: string;
        entity_id: string | null;
        source: string;
        ip_address: string | null;
        user_agent: string | null;
        before_payload: Json | null;
        after_payload: Json | null;
        created_at: Timestamp;
      }>;
      motorist_telnyx_webhook_events: Table<{
        event_id: string;
        organization_id: string | null;
        event_type: string;
        call_session_id: string | null;
        call_leg_id: string | null;
        call_control_id: string | null;
        connection_id: string | null;
        status: "queued" | "processed" | "failed";
        attempts: number;
        claimed_at: Timestamp | null;
        error: string | null;
        payload: Json | null;
        occurred_at: Timestamp | null;
        received_at: Timestamp;
        processed_at: Timestamp | null;
      }>;
      motorist_call_sessions: Table<{
        id: string;
        organization_id: string;
        telnyx_session_id: string | null;
        direction: "inbound" | "outbound" | "internal";
        state: CallSessionState;
        version: number;
        lease_token: string | null;
        lease_until: Timestamp | null;
        line_id: string | null;
        ring_plan_id: string | null;
        current_step: number;
        conference_id: string | null;
        conference_name: string | null;
        customer_leg_id: string | null;
        answered_by_profile_id: string | null;
        case_id: string | null;
        caller_number: string | null;
        called_number: string | null;
        started_at: Timestamp;
        answered_at: Timestamp | null;
        ended_at: Timestamp | null;
        hold_started_at: Timestamp | null;
        parked_at: Timestamp | null;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_call_legs: Table<{
        id: string;
        organization_id: string;
        session_id: string;
        telnyx_call_control_id: string;
        telnyx_call_leg_id: string | null;
        role: CallLegRole;
        profile_id: string | null;
        to_number: string | null;
        from_number: string | null;
        state: CallLegState;
        hangup_cause: string | null;
        hangup_source: string | null;
        initiated_at: Timestamp;
        answered_at: Timestamp | null;
        bridged_at: Timestamp | null;
        ended_at: Timestamp | null;
        client_state: Json;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_ring_plans: Table<{
        id: string;
        organization_id: string;
        name: string;
        fallback_kind: "external_number" | "waiting_room" | "callback_prompt" | "hangup_message";
        fallback_number: string | null;
        active: boolean;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_ring_plan_steps: Table<{
        id: string;
        organization_id: string;
        ring_plan_id: string;
        step_index: number;
        ring_group_id: string;
        timeout_secs: number;
        strategy: "all" | "ordered";
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_ring_groups: Table<{
        id: string;
        organization_id: string;
        name: string;
        description: string | null;
        active: boolean;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_ring_group_members: Table<{
        id: string;
        organization_id: string;
        ring_group_id: string;
        member_kind: RingMemberKind;
        profile_id: string | null;
        external_number: string | null;
        position: number;
        ring_secs: number | null;
        last_offered_at: Timestamp | null;
        last_answered_at: Timestamp | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_ring_attempts: Table<{
        id: string;
        organization_id: string;
        session_id: string;
        step_index: number;
        ring_group_id: string | null;
        member_kind: RingMemberKind;
        profile_id: string | null;
        external_number: string | null;
        leg_id: string | null;
        position: number;
        ring_secs: number;
        result: RingAttemptResult;
        offered_at: Timestamp | null;
        answered_at: Timestamp | null;
        ended_at: Timestamp | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_business_hours: Table<{
        id: string;
        organization_id: string;
        name: string;
        timezone: string;
        active: boolean;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_business_hours_intervals: Table<{
        id: string;
        organization_id: string;
        business_hours_id: string;
        weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
        opens: string;
        closes: string;
        created_at: Timestamp;
      }>;
      motorist_business_hours_exceptions: Table<{
        id: string;
        organization_id: string;
        business_hours_id: string;
        date: string;
        closed: boolean;
        intervals: Json;
        label: string | null;
        created_at: Timestamp;
      }>;
      motorist_ivr_menus: Table<{
        id: string;
        organization_id: string;
        name: string;
        prompt_media_url: string | null;
        tts_text: string | null;
        invalid_media_url: string | null;
        timeout_secs: number;
        max_tries: number;
        active: boolean;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_ivr_options: Table<{
        id: string;
        organization_id: string;
        ivr_menu_id: string;
        digit: string;
        action: "ring_plan" | "callback" | "external_number" | "waiting_room" | "repeat" | "hangup";
        target_ring_plan_id: string | null;
        target_number: string | null;
        label: string;
        prompt_media_url: string | null;
        tts_text: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_callback_requests: Table<{
        id: string;
        organization_id: string;
        caller_number: string;
        caller_name: string | null;
        source: "ivr" | "after_hours" | "park_timeout" | "missed" | "manual";
        status: "open" | "scheduled" | "done" | "cancelled";
        session_id: string | null;
        line_id: string | null;
        case_id: string | null;
        claimed_by: string | null;
        claimed_at: Timestamp | null;
        due_at: Timestamp | null;
        resolved_at: Timestamp | null;
        notes: string | null;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_operator_devices: Table<{
        id: string;
        organization_id: string;
        profile_id: string;
        environment: TelephonyEnvironment;
        telnyx_credential_id: string | null;
        sip_username: string | null;
        credential_expires_at: Timestamp | null;
        last_token_issued_at: Timestamp | null;
        token_expires_at: Timestamp | null;
        device_seen_at: Timestamp | null;
        device_session_id: string | null;
        registration_state: "unregistered" | "registering" | "registered" | "error";
        user_agent: string | null;
        metadata: Json;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_operator_presence: Table<{
        id: string;
        organization_id: string;
        profile_id: string;
        status: OperatorPresenceStatus;
        current_session_id: string | null;
        pause_reason_id: string | null;
        wrap_up_until: Timestamp | null;
        status_since: Timestamp;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_pause_reasons: Table<{
        id: string;
        organization_id: string;
        code: string;
        label: string;
        max_minutes: number | null;
        sort_order: number;
        active: boolean;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_operator_telephony_settings: Table<{
        id: string;
        organization_id: string;
        profile_id: string;
        default_from_line_id: string | null;
        wrap_up_seconds: number;
        auto_answer_outbound: boolean;
        ring_device_volume: number;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_telephony_settings: Table<{
        id: string;
        organization_id: string;
        live_calls_enabled: boolean;
        sms_live_sends: boolean;
        daily_leg_soft_cap: number;
        park_max_minutes: number;
        destination_allowlist: string[];
        max_ring_fanout: number;
        max_concurrent_legs: number;
        routing_version: number;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_telephony_daily_usage: Table<{
        id: string;
        organization_id: string;
        day: string;
        legs: number;
        minutes: number;
        sms_count: number;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_telephony_alerts: Table<{
        id: string;
        organization_id: string;
        alert_key: string;
        status: "warn" | "fail";
        detail: Json;
        sends: number;
        first_sent_at: Timestamp;
        last_sent_at: Timestamp;
        last_seen_at: Timestamp;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_job_controls: Table<{
        job_name: string;
        enabled: boolean;
        updated_at: Timestamp;
        updated_by: string | null;
      }>;
      motorist_job_runs: Table<{
        run_id: string;
        job_name: string;
        scheduled_for: Timestamp;
        payload: Json;
        payload_hash: string;
        status: "queued" | "running" | "succeeded" | "failed" | "dead";
        attempt: number;
        next_attempt_at: Timestamp | null;
        lease_owner: string | null;
        lease_expires_at: Timestamp | null;
        lease_heartbeat_at: Timestamp | null;
        started_at: Timestamp | null;
        finished_at: Timestamp | null;
        result_safe: Json | null;
        error_safe: string | null;
        created_at: Timestamp;
        updated_at: Timestamp;
      }>;
      motorist_worker_status: Table<{
        instance_id: string;
        deployment_version: string;
        heartbeat_at: Timestamp;
        scheduler_tick_at: Timestamp | null;
        scheduler_status: string;
        last_webhook_at: Timestamp | null;
        updated_at: Timestamp;
      }>;
      motorist_job_incidents: Table<{
        incident_id: string;
        job_name: string;
        status: "open" | "recovered";
        consecutive_failures: number;
        opened_at: Timestamp;
        last_alert_at: Timestamp | null;
        recovered_at: Timestamp | null;
        last_error_safe: string | null;
        updated_at: Timestamp;
      }>;
    };
    Views: {
      // Phase 4 statistics views (migration 20260921100000). Read-only: the
      // typed client only ever selects from them.
      motorist_call_stats_daily: View<{
        organization_id: string;
        /** Local (Europe/Bratislava) calendar day, `YYYY-MM-DD`. */
        day: string;
        direction: "inbound" | "outbound" | "internal";
        operator_id: string | null;
        calls: number;
        answered: number;
        unanswered: number;
        system_handled: number;
        abandoned: number;
        answered_with_wait: number;
        answered_within_20s: number;
        answer_seconds_total: number;
        talk_seconds: number;
      }>;
      motorist_operator_status_durations: View<{
        organization_id: string;
        profile_id: string;
        day: string;
        status: Database["public"]["Tables"]["motorist_operator_statuses"]["Row"]["status"];
        entries: number;
        seconds: number;
        last_started_at: Timestamp;
        open_since: Timestamp | null;
      }>;
    };
    Functions: {
      motorist_enqueue_job_run: {
        Args: {
          p_run_id: string;
          p_job_name: string;
          p_scheduled_for: Timestamp;
          p_payload: Json;
          p_payload_hash: string;
        };
        Returns: Database["public"]["Tables"]["motorist_job_runs"]["Row"];
      };
      motorist_claim_job_run: {
        Args: {
          p_worker_id: string;
          p_lease_seconds: number;
        };
        Returns: Database["public"]["Tables"]["motorist_job_runs"]["Row"][];
      };
      motorist_renew_job_run_lease: {
        Args: {
          p_run_id: string;
          p_worker_id: string;
          p_lease_seconds: number;
        };
        Returns: boolean;
      };
      motorist_complete_job_run: {
        Args: {
          p_run_id: string;
          p_worker_id: string;
          p_result_safe: Json;
        };
        Returns: boolean;
      };
      motorist_fail_job_run: {
        Args: {
          p_run_id: string;
          p_worker_id: string;
          p_error_safe: string;
          p_next_attempt_at: Timestamp;
          p_terminal: boolean;
        };
        Returns: boolean;
      };
      motorist_telnyx_claim_webhook_event: {
        Args: {
          p_event_id: string;
          p_event_type: string;
          p_payload: Json;
          p_organization_id?: string | null;
          p_call_session_id?: string | null;
          p_call_leg_id?: string | null;
          p_call_control_id?: string | null;
          p_connection_id?: string | null;
          p_occurred_at?: Timestamp | null;
          p_stale_after_ms?: number;
        };
        Returns: {
          outcome: "claimed" | "duplicate" | "busy";
          event_status: "queued" | "processed" | "failed";
          event_attempts: number;
          event_claimed_at: Timestamp | null;
        }[];
      };
      motorist_session_lease_acquire: {
        Args: {
          p_session_id: string;
          p_token: string;
          p_ttl_ms?: number;
        };
        Returns: boolean;
      };
      motorist_session_lease_release: {
        Args: {
          p_session_id: string;
          p_token: string;
        };
        Returns: boolean;
      };
      motorist_reserve_operator: {
        Args: {
          p_profile_id: string;
          p_session_id: string;
        };
        Returns: boolean;
      };
      motorist_advance_ring_step: {
        Args: {
          p_session_id: string;
          p_expected_step: number;
        };
        Returns: boolean;
      };
      motorist_replace_ring_plan: {
        Args: {
          p_organization_id: string;
          p_document: Json;
          p_expected_version?: number | null;
        };
        Returns: Json;
      };
      motorist_telephony_usage_add: {
        Args: {
          p_organization_id: string;
          p_day: string;
          p_legs?: number;
          p_minutes?: number;
          p_sms?: number;
        };
        Returns: number;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
