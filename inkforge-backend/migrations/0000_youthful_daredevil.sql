CREATE TABLE `card_data_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`card_name` text NOT NULL,
	`set_name` text NOT NULL,
	`set_code` text,
	`collector_number` text,
	`game` text DEFAULT 'lorcana' NOT NULL,
	`rarity` text,
	`ink_cost` integer,
	`ink_color` text,
	`card_type` text,
	`image_url` text,
	`cardmarket_product_id` text,
	`lorcana_api_id` text,
	`lorcast_id` text,
	`last_refreshed` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cache_card_set_game_idx` ON `card_data_cache` (`card_name`,`set_name`,`game`);--> statement-breakpoint
CREATE INDEX `cache_product_id_idx` ON `card_data_cache` (`cardmarket_product_id`);--> statement-breakpoint
CREATE TABLE `cardmarket_sellers` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`country` text,
	`is_professional` integer DEFAULT false NOT NULL,
	`vat_number` text,
	`first_purchase_date` text,
	`total_orders` integer DEFAULT 0 NOT NULL,
	`total_spend_pence` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cardmarket_sellers_username_unique` ON `cardmarket_sellers` (`username`);--> statement-breakpoint
CREATE TABLE `import_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`file_hash` text NOT NULL,
	`file_type` text NOT NULL,
	`rows_processed` integer DEFAULT 0 NOT NULL,
	`rows_skipped` integer DEFAULT 0 NOT NULL,
	`imported_at` text NOT NULL,
	`imported_by` text DEFAULT 'owner'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_hash_idx` ON `import_logs` (`file_hash`);--> statement-breakpoint
CREATE TABLE `inventory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`card_name` text NOT NULL,
	`set_name` text NOT NULL,
	`game` text NOT NULL,
	`product_id` text,
	`collector_number` text,
	`category` text NOT NULL,
	`condition` text DEFAULT 'NM' NOT NULL,
	`grade_company` text,
	`grade_value` text,
	`quantity_total` integer DEFAULT 0 NOT NULL,
	`quantity_available` integer DEFAULT 0 NOT NULL,
	`quantity_listed` integer DEFAULT 0 NOT NULL,
	`quantity_reserved` integer DEFAULT 0 NOT NULL,
	`quantity_grading` integer DEFAULT 0 NOT NULL,
	`cost_basis_avg_pence` integer DEFAULT 0 NOT NULL,
	`cost_basis_total_pence` integer DEFAULT 0 NOT NULL,
	`market_value_current_pence` integer,
	`location` text,
	`first_acquired` text NOT NULL,
	`last_acquired` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inventory_card_idx` ON `inventory_items` (`card_name`);--> statement-breakpoint
CREATE INDEX `inventory_set_idx` ON `inventory_items` (`set_name`);--> statement-breakpoint
CREATE INDEX `inventory_game_idx` ON `inventory_items` (`game`);--> statement-breakpoint
CREATE INDEX `inventory_condition_idx` ON `inventory_items` (`condition`);--> statement-breakpoint
CREATE INDEX `inventory_location_idx` ON `inventory_items` (`location`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_unique_item_idx` ON `inventory_items` (`card_name`,`set_name`,`game`,`condition`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`platform` text NOT NULL,
	`platform_ref` text,
	`card_name` text NOT NULL,
	`set_name` text NOT NULL,
	`game` text NOT NULL,
	`product_id` text,
	`collector_number` text,
	`category` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_pence` integer NOT NULL,
	`total_price_pence` integer NOT NULL,
	`shipping_cost_pence` integer,
	`platform_fees_pence` integer,
	`other_costs_pence` integer,
	`net_amount_pence` integer NOT NULL,
	`condition` text DEFAULT 'NM' NOT NULL,
	`grade_company` text,
	`grade_value` text,
	`currency_original` text,
	`currency_rate` integer,
	`notes` text,
	`bundle_id` text,
	`market_value_at_acquisition_pence` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_date_idx` ON `ledger_entries` (`date`);--> statement-breakpoint
CREATE INDEX `ledger_platform_idx` ON `ledger_entries` (`platform`);--> statement-breakpoint
CREATE INDEX `ledger_card_idx` ON `ledger_entries` (`card_name`);--> statement-breakpoint
CREATE INDEX `ledger_set_idx` ON `ledger_entries` (`set_name`);--> statement-breakpoint
CREATE INDEX `ledger_game_idx` ON `ledger_entries` (`game`);--> statement-breakpoint
CREATE INDEX `ledger_type_idx` ON `ledger_entries` (`type`);--> statement-breakpoint
CREATE INDEX `ledger_bundle_idx` ON `ledger_entries` (`bundle_id`);--> statement-breakpoint
CREATE INDEX `ledger_source_idx` ON `ledger_entries` (`source`);--> statement-breakpoint
CREATE INDEX `ledger_platform_ref_idx` ON `ledger_entries` (`platform_ref`);--> statement-breakpoint
CREATE TABLE `market_data_records` (
	`id` text PRIMARY KEY NOT NULL,
	`card_name` text NOT NULL,
	`set_name` text NOT NULL,
	`game` text NOT NULL,
	`source` text NOT NULL,
	`price_pence` integer NOT NULL,
	`shipping_pence` integer,
	`condition` text,
	`listing_type` text NOT NULL,
	`date_sold` text,
	`date_captured` text NOT NULL,
	`graded` integer DEFAULT false NOT NULL,
	`grade_company` text,
	`grade_value` text,
	`seller_name` text,
	`capture_method` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `market_card_idx` ON `market_data_records` (`card_name`);--> statement-breakpoint
CREATE INDEX `market_set_idx` ON `market_data_records` (`set_name`);--> statement-breakpoint
CREATE INDEX `market_source_idx` ON `market_data_records` (`source`);--> statement-breakpoint
CREATE INDEX `market_date_sold_idx` ON `market_data_records` (`date_sold`);--> statement-breakpoint
CREATE INDEX `market_listing_type_idx` ON `market_data_records` (`listing_type`);--> statement-breakpoint
CREATE TABLE `price_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`card_name` text,
	`set_name` text,
	`game` text,
	`alert_type` text NOT NULL,
	`threshold_value` integer NOT NULL,
	`threshold_unit` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_triggered` text,
	`channel` text DEFAULT 'in_app' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`platform` text NOT NULL,
	`frequency_minutes` integer DEFAULT 120 NOT NULL,
	`last_captured` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
