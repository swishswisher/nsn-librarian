export type NsnTaxonomyNode = {
  name: string;
  slug: string;
  children?: NsnTaxonomyNode[];
};

const clinicalCategoryChildren = [
  { name: "Articles", slug: "articles" },
  { name: "Worksheets", slug: "worksheets" },
  { name: "Research", slug: "research" },
  { name: "Books", slug: "books" },
] satisfies NsnTaxonomyNode[];

const clinicalCategories = [
  "Addiction",
  "Attachment",
  "Couples",
  "DBT",
  "Family Systems",
  "Grief",
  "Mindfulness",
  "Somatic",
  "Trauma",
  "Worksheets",
].map((name) => ({
  name,
  slug: name.toLowerCase().replaceAll(" ", "-"),
  children: clinicalCategoryChildren,
})) satisfies NsnTaxonomyNode[];

export const nsnTaxonomy = [
  { name: "01 Articles", slug: "01-articles" },
  { name: "02 Newsletters", slug: "02-newsletters" },
  { name: "03 WKBK & Worksheets", slug: "03-wkbk-worksheets" },
  { name: "04 Media", slug: "04-media" },
  { name: "05 Website", slug: "05-website" },
  {
    name: "06 Clinical Library",
    slug: "06-clinical-library",
    children: [
      ...clinicalCategories.slice(0, 1),
      {
        name: "Assessment Tools",
        slug: "assessment-tools",
        children: [
          { name: "Assessments", slug: "assessments" },
          { name: "Scoring Guides", slug: "scoring-guides" },
          { name: "Reference Materials", slug: "reference-materials" },
        ],
      },
      ...clinicalCategories.slice(1),
    ],
  },
  { name: "07 Research AI Ethics", slug: "07-research-ai-ethics" },
  { name: "08 Publishing", slug: "08-publishing" },
  { name: "09 NSN Infrastructure", slug: "09-nsn-infrastructure" },
  {
    name: "10 Research Library",
    slug: "10-research-library",
    children: [
      { name: "AI & Ethics", slug: "ai-ethics" },
      { name: "Attachment Research", slug: "attachment-research" },
      { name: "Neuroscience", slug: "neuroscience" },
      {
        name: "Polyvagal & Autonomic Nervous System",
        slug: "polyvagal-autonomic-nervous-system",
      },
      { name: "Mindfulness Research", slug: "mindfulness-research" },
      { name: "Somatic Research", slug: "somatic-research" },
      { name: "Trauma Research", slug: "trauma-research" },
      {
        name: "Relationships & Couples Research",
        slug: "relationships-couples-research",
      },
      { name: "Family Systems Research", slug: "family-systems-research" },
      { name: "Addiction Research", slug: "addiction-research" },
      { name: "Grief Research", slug: "grief-research" },
      { name: "Human Development", slug: "human-development" },
      {
        name: "Consciousness & Philosophy",
        slug: "consciousness-philosophy",
      },
      {
        name: "Books & Reference Materials",
        slug: "books-reference-materials",
      },
      { name: "Article Source Material", slug: "article-source-material" },
      {
        name: "Speaker / Presentation Research",
        slug: "speaker-presentation-research",
      },
    ],
  },
] satisfies NsnTaxonomyNode[];
