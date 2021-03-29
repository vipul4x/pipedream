const crypto = require("crypto");
const difference = require("lodash/difference");
const zoom_admin = require("../../zoom_admin.app");

module.exports = {
  name: "Changes to Webinar Panelists",
  key: "zoom-admin-webinar-changes-to-panelists",
  version: "0.0.1",
  description:
    "Emits an event every time a panelist is added or removed from a webinar, or any time their details change",
  dedupe: "unique",
  props: {
    zoom_admin,
    webinars: { propDefinition: [zoom_admin, "webinars"] },
    db: "$.service.db",
    timer: {
      type: "$.interface.timer",
      default: {
        intervalSeconds: 60 * 15,
      },
    },
  },
  hooks: {
    async deploy() {
      // Fetch and emit sample events
      await this.fetchAndEmitParticipants();
    },
  },
  methods: {
    generateMeta(eventType, panelist) {
      const { id: panelistID, email, name } = panelist;
      const summary = name
        ? `${eventType} - ${name} - ${email}`
        : `${eventType} - ${email}`;
      return {
        id: `${panelistID}-${eventType}`,
        summary,
      };
    },
    hash(str) {
      return crypto.createHash("sha256").update(str).digest("hex");
    },
    async fetchAndEmitParticipants() {
      // This endpoint allows for no time filter, so we fetch all participants from
      // all configured webinars and let the deduper handle duplicates
      const webinars = this.webinars || [];
      if (!this.webinars || !this.webinars.length) {
        let nextPageToken;
        do {
          const resp = await this.zoom_admin.listWebinars({
            nextPageToken,
          });
          for (const webinar of resp.webinars) {
            webinars.push(webinar.id);
          }
          nextPageToken = resp.next_page_token;
        } while (nextPageToken);
      }

      for (webinarID of webinars) {
        const { panelists } = await this.zoom_admin.listWebinarPanelists(
          webinarID
        );
        // We keep a DB key for each webinar, which contains an object
        // of panelists with the content of the panelist metadata,
        // to support change detection.
        const oldPanelists = this.db.get(webinarID) || {};
        console.log("Old panelists: ", oldPanelists);
        const oldPanelistIDs = Object.keys(oldPanelists);
        console.log("Old panelists IDs: ", oldPanelistIDs);
        const newPanelistIDs = panelists.map((p) => p.id);
        console.log("New panelists IDs: ", newPanelistIDs);

        // DELETED PANELISTS
        const deletedPanelistIDs = difference(oldPanelistIDs, newPanelistIDs);
        console.log("Deleted panelists IDs: ", deletedPanelistIDs);

        let eventType = "panelist.deleted";
        for (const panelistID of deletedPanelistIDs) {
          const panelist = oldPanelists[panelistID];
          this.$emit(
            { eventType, ...panelist, webinarID },
            this.generateMeta(eventType, panelist)
          );
        }

        // ADDED PANELISTS
        const addedPanelistIDs = difference(newPanelistIDs, oldPanelistIDs);
        console.log("Added panelist IDs: ", addedPanelistIDs);

        const newPanelists = {};
        for (const panelist of panelists) {
          newPanelists[panelist.id] = panelist;
          if (addedPanelistIDs.includes(panelist.id)) {
            eventType = "panelist.added";
            this.$emit(
              { eventType, ...panelist, webinarID },
              this.generateMeta(eventType, panelist)
            );
          }
          if (
            panelist.id in oldPanelists &&
            this.hash(JSON.stringify(panelist)) !==
              this.hash(JSON.stringify(oldPanelists[panelist.id]))
          ) {
            eventType = "panelist.changed";
            this.$emit(
              { eventType, ...panelist, webinarID },
              this.generateMeta(eventType, panelist)
            );
          }
        }

        this.db.set(webinarID, newPanelists);
      }
    },
  },
  async run(event) {
    await this.fetchAndEmitParticipants();
  },
};
