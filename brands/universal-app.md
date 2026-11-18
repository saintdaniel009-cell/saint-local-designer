# Brand: Universal app kit (any mobile app)
Use with the "Universal UI Kit" Figma file (duplicate it per project). Frame 390 × 844.
Neutral black-and-white style; the project's brand colour lives in the "color/primary" variable in Figma.

## Build from components first
- Every screen: Status bar (w "fill"), then Top bar (props Title, Back, Show action, Action icon) on inner screens.
- Then one Body frame: layout col, pad [16,24,32,24], gap 24, w "fill". Main tab screens use paddingBottom 120 and end with Tab bar (absolute, x 16, y 752; props Active 1–5, Tab 1–5, Icon 1–5).
- Forms: Input / Text area / Select / Search bar, Checkbox, Radio, Toggle, Segmented control. One Button (Style Primary, Size Large, w "fill") at the bottom.
- Lists: a titled list = frame (col, gap 8) holding Section header + a List frame (col, gap 0) of List rows or Message rows.
- Content: Card, Product card (2 per row: a row frame with gap 16, each w "fill"), Image (Ratio Square|Wide|Tall), Avatar, Badge, Chip row.
- Feedback: Empty state, Toast (absolute near the bottom), Dialog or Bottom sheet over a dimmed frame ({"type":"frame","absolute":true,"x":0,"y":0,"w":390,"h":844,"fill":"#00000066"}).
- Progress: Stepper (onboarding), Progress bar, Code input (verification).
- Icons by name in any Icon prop: Home, Search, User, Bell, Settings, Plus, Close, Check, ChevronRight, ChevronDown, ArrowLeft, ArrowRight, Heart, Star, Cart, Calendar, Mail, Lock, Menu, Filter, Share, Trash, Edit, Camera, Location, Chat, Play, Upload, Wallet, Card.

## Dark mode
Add "modes": {"Theme": "Dark"} to a screen to render it in dark mode.

## Characters (illustrations, onboarding, empty states)
{"type":"instance","component":"Character","props":{"Head":"Round","Hair":"Afro","Eyes":"Happy","Brows":"Raised","Mouth":"Smile","Outfit":"Hoodie","Accessory":"Glasses"},"modes":{"Skin":"Tone 4","Hair color":"Black","Outfit color":"Forest"}}
Options: Head Round/Oval/Square · Hair Short/Curly/Afro/Long/Bun/Braids/Locs/Fade/Bald · Eyes Open/Happy/Closed/Wink/Surprised/Side · Brows Neutral/Raised/Angry/Worried · Mouth Smile/Neutral/Open/E/O/Laugh/Frown/F · Outfit Tee/Shirt/Hoodie/Blazer/Dress/Scrubs/Kaftan · Accessory None/Glasses/Cap/Headwrap/Earrings/Headphones.
Colours: Skin Tone 1–5 · Hair color Black/Dark brown/Auburn/Blonde/Grey · Outfit color Ink/Navy/Forest/Rust/Plum/Sky. Mix skin tones across a group.

## Style
- Inter everywhere, tracking -2. Titles 24–28 bold, body 15, labels 13.
- Minimal: one primary action per screen, no taglines, real copy.
