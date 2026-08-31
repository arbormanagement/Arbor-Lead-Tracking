import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns, sources, trackingNumbers } from "@/lib/db/schema";

/**
 * The tracking-number list, resolved rather than raw.
 *
 * `GET /api/numbers` returned `staticSourceId` and no campaign at all, which is a
 * row a machine caller cannot act on: to point a number at a campaign you have to
 * know what it is currently pointed at, and an opaque id answers nothing. Joining
 * the source key and campaign name here is what makes the MCP `list_numbers` /
 * `update_number` pair usable without a second lookup per row.
 */
export interface TrackingNumberRow {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  pool: string;
  status: string;
  /** Static numbers name their own source and campaign; pooled ones inherit both
   *  from the visitor's DNI lease, which is why those fields read null here. */
  isStatic: boolean;
  sourceKey: string | null;
  staticCampaignId: string | null;
  campaignName: string | null;
  location: string | null;
  forwardDestination: string | null;
  recordCalls: boolean;
}

export async function listTrackingNumbers(): Promise<TrackingNumberRow[]> {
  return db
    .select({
      id: trackingNumbers.id,
      phoneNumber: trackingNumbers.phoneNumber,
      friendlyName: trackingNumbers.friendlyName,
      pool: trackingNumbers.pool,
      status: trackingNumbers.status,
      isStatic: trackingNumbers.isStatic,
      sourceKey: sources.key,
      staticCampaignId: trackingNumbers.staticCampaignId,
      campaignName: campaigns.name,
      location: trackingNumbers.location,
      forwardDestination: trackingNumbers.forwardDestination,
      recordCalls: trackingNumbers.recordCalls,
    })
    .from(trackingNumbers)
    .leftJoin(sources, eq(trackingNumbers.staticSourceId, sources.id))
    .leftJoin(campaigns, eq(trackingNumbers.staticCampaignId, campaigns.id))
    .orderBy(asc(trackingNumbers.createdAt));
}
