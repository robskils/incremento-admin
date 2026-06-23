-- Component library: service-grouped catalogue of Incremento specialities.
-- Clears the old kind-only starters (no service), then seeds the catalogue.
DELETE FROM proposal_blocks WHERE service IS NULL;

INSERT INTO proposal_blocks (kind, service, title, body, price, extra, created_at) VALUES
-- Web Design
('component','web-design','Responsive website design','A bespoke, responsive design that looks and performs beautifully on every screen, built around your brand and your customers.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-design','Brand-led visual design','A distinctive look and feel - colour, type, imagery and tone - that makes your business instantly recognisable.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-design','Design system & components','A reusable kit of styles and components so every page stays consistent and future pages are quick to build.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-design','Wireframes & interactive prototype','Clickable wireframes that map the journey and let you feel the site before a line of code is written.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-design','Copywriting & content structure','Clear, persuasive copy and a structure designed to guide visitors towards taking action.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-design','Accessibility (WCAG)','An accessible build - semantic markup, keyboard navigation, contrast and alt text - so everyone can use your site, and Google rewards it.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- Web Development
('component','web-development','Hand-coded front-end build','A fast, clean, hand-built front end with no bloated page builders - for speed, reliability and easy maintenance.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-development','Editable content / CMS','A simple way for your team to update content and pages without touching code.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-development','Contact & enquiry forms','Reliable forms that deliver straight to your inbox and capture every lead.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-development','Core Web Vitals & performance','Tuned for Google''s Core Web Vitals: fast loads, smooth interaction and stable layout.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-development','Third-party & API integrations','Connecting your site to the tools you already use - CRMs, booking, payments and more.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','web-development','Multilingual / localisation','Multiple language versions with correct hreflang and localised URLs, done properly for search.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- SEO
('component','seo','On-page optimisation','Titles, headings, meta, internal linking and content optimised so each page can rank and convert.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','seo','Keyword research & strategy','Mapping the terms your customers actually search, and the intent behind them, into a clear content plan.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','seo','Technical SEO audit & fixes','Crawlability, indexing, speed, structured data and the technical foundations rankings depend on.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','seo','Local SEO & Google Business Profile','An optimised local presence so you show up for nearby, high-intent searches.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','seo','Structured data / schema markup','Rich-result markup (FAQ, reviews, articles) so your listings stand out in search.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','seo','Content & authority building','Genuinely useful content that builds the topical authority Google rewards over time.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- AI & Automation
('component','ai','AI customer-support assistant','A support assistant grounded in your own content (retrieval-augmented), answering accurately around the clock with a clean escalation path to a human.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ai','Semantic site search','Search that understands intent, not just keywords, so visitors find the right product or page even when they don''t use your exact words.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ai','AI content & translation at scale','Drafting product copy, metadata and first-pass translations at speed, with a human keeping the final, judgement-heavy part sharp.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ai','Smart personalisation','Adapting content and recommendations to each visitor''s behaviour - attentive, never creepy.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ai','Model API integration','Wiring your site to AI model APIs with structured output, tool use, caching, streaming and graceful fallbacks - fast, predictable and affordable.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ai','Back-office automation','Summarising, categorising and routing enquiries and documents automatically, so your team spends time selling, not sorting.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- Analytics & Tracking
('component','analytics','Google Analytics (GA4) setup','Full GA4 configuration with the events and goals that actually matter to your business.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','analytics','Visitor tracking setup','Visitor-level tracking so you can see who is on your site and how they behave, not just anonymous numbers.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','analytics','Conversion & goal tracking','Tracking the actions that mean money - enquiries, calls, bookings, sales - so you know what is working.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','analytics','Google Tag Manager','A clean tag setup so marketing pixels and tags can be managed without touching code.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','analytics','Dashboards & reporting','A simple dashboard that turns the numbers into decisions, with regular reporting.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','analytics','Conversion-rate optimisation (CRO)','Testing and refining the journey to turn more of your existing traffic into customers.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- Hosting & Infrastructure
('component','infrastructure','Hosting & infrastructure setup','Fast, secure, global hosting on modern edge infrastructure - configured, deployed and handed over.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','infrastructure','Free hosting up to 100k hits/day','Your website is free to run once built, up to 100,000 hits per day. At that point, you''ll be happy to pay!',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','infrastructure','Domain & DNS configuration','Domain connection, DNS and records set up correctly so everything just works.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','infrastructure','SSL & security','HTTPS everywhere, security headers and best-practice protection as standard.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','infrastructure','Backups & uptime monitoring','Automated backups and monitoring so your site stays online and recoverable.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','infrastructure','CDN & edge caching','Global content delivery and caching for fast loads wherever your visitors are.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- Email
('component','email','Email accounts setup','Professional email on your own domain (you@yourbusiness.com), set up and working across your devices.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','email','Deliverability & transactional email','Reliable automated emails (receipts, notifications, enquiries) configured to land in the inbox, not spam.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','email','Inbound email capture','Inbound email routed into your admin timeline so every client conversation lives in one place.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','email','Newsletter & marketing email','A marketing-email platform connected and ready, with templates on brand.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- E-commerce
('component','ecommerce','Online store build','A clean, fast store designed to turn browsers into buyers.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ecommerce','Payment gateway integration','Secure card and local payment methods connected and tested.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ecommerce','Product catalogue & inventory','Product, category and stock setup that is easy for you to manage.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ecommerce','Checkout optimisation','A frictionless checkout designed to reduce drop-off and lift conversion.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- UX & Product Design
('component','ux','Discovery & strategy workshop','A structured session to align on goals, audience and success metrics before design begins.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ux','User research & testing','Talking to real users and testing designs so decisions are evidence-led.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ux','Information architecture','Structuring content around your customers'' problems, not your org chart.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','ux','UI design & prototyping','High-fidelity design and interactive prototypes you can click through before build.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- Paid & Social
('component','paid','Google Ads setup & management','Campaigns built around high-intent searches and managed to a target cost per lead.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','paid','Paid social campaigns','Targeted social advertising that reaches the right audience and is measured on results.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','paid','Campaign landing pages','Conversion-focused landing pages built to match your ads and turn clicks into leads.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','paid','Tracking & attribution','Proper conversion tracking so you know which spend actually pays back.',NULL,NULL,'2026-06-21T20:00:00Z'),
-- General & Terms
('component','general','Warm intro','Thanks for the opportunity to put this together. Below is the scope, timeline and investment, tailored to the goals we discussed.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','general','Discovery-first approach','We start with your goals and your customers, not a template, so what we build actually moves your numbers.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','general','Why Incremento','A focused studio - web, product and growth under one roof, plus Incremento Labs for applied AI. Six years, 20+ projects, senior specialists only.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','general','Payment terms','50% deposit to begin, 50% on launch. Invoices are payable within 14 days.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','general','Timeline note','Most projects run 4-8 weeks depending on scope; we confirm milestones up front.',NULL,NULL,'2026-06-21T20:00:00Z'),
('component','general','Ongoing support','Optional ongoing support and improvements once you are live - we don''t disappear at launch.',NULL,NULL,'2026-06-21T20:00:00Z');
