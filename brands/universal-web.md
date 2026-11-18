# Brand: Universal web kit (websites and dashboards)
Use with the "Universal UI Kit" Figma file. Page frame 1440 wide; height grows with content.

## Landing pages (top to bottom)
Navbar → Hero (Layout Split|Centered) → sections → CTA banner → Footer. Navbar, Hero and Footer are 1440 wide; use no page padding for them.
- A section = frame (layout col, cross "center", pad [96,120], gap 48, w "fill"): Section heading (Eyebrow, Title, Body), then content.
- Feature grid: row frame (gap 24, w "fill") of 3 Feature cards, each w "fill".
- Stats: row of 3–4 Stat, align "space".
- Pricing: row of 3 Pricing card (middle one Highlight Yes), each w "fill".
- Social proof: row of 3 Testimonial, each w "fill".
- FAQ: column of FAQ item (first Open Yes), w 720, gap 0.
- CTA banner (1200 wide) sits inside a section with pad [48,120].

## Dashboards
Root frame layout "row": a Sidebar frame (layout col, w 264, h "fill", pad 16, gap 4, fill "surface") of Nav items (one State Active), then a Main frame (layout col, w "fill", pad 40, gap 32) with Page header, a row of 4 Metric cards (each w "fill"), and a table (col, gap 0): one Table row Type Header, then Rows.
- Use Button, Input, Select, Badge, Avatar, Chip, Segmented control from the app kit; they work on web too.

## Characters
Same Character component and options as the app kit (see universal-app.md). Good for hero images and empty states.

## Style
- Inter, tracking -2. Hero headline 56–64 bold, section titles 40, body 16–19.
- Generous whitespace, black-and-white base, brand colour only from "color/primary".
