# Free roads — stage 12

Primary sources consulted on 2026-10-01:

- [ASAM OpenDRIVE lane definitions](https://www.asam.net/fileadmin/Standards/OpenDRIVE/ASAM_OpenDRIVE_BS_V1-7-0.html): authored lane widths and purpose belong to the road document; width profiles have nonnegative values and ordered longitudinal positions.
- [Esri CityEngine Street Designer](https://doc.arcgis.com/en/cityengine/latest/help/street-designer-overview.htm): lane editing and reusable street configurations are available through the inspector alongside drawing tools.
- [Eclipse SUMO network format](https://eclipse.dev/sumo/docs/Networks/PlainXML.html): roundabout identity is made from directed edges and nodes; priority at approaches must respect circulating traffic.

Implementation sequence for the approved master plan:

1. Persist optional section dimensions without changing old maps. Resolve one profile for geometry, lanelets and the inspector. Expose width, footway, median, speed and priority under `?roads=free`, with pointer/touch range controls and exact undo.
2. Add an atomic curved one-way roundabout command and expose it in the road palette. Verify entrance priority, save/load and undo, then photograph actual use in the game.
3. Extend the authored section to independent semantic bands and longitudinal transitions; derive permitted connections and markings from those bands. Add pedestrian streets, alleys, dirt roads, separated cycleways, crossings, humps and tram bands.
4. Measure complete edits (document, network and rendered frame), check incremental/rebuilt equivalence, photograph every new type with users, and only request default promotion once all stage-12 acceptance conditions pass.

The first batch is a symmetric-section slice, not completion of stage 12. Independent sides, typed bands, transitions and new transport modes remain subsequent work. Existing pedestrian consumers outside B's ownership require an acknowledged claim on the coordination board.
