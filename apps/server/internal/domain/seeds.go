package domain

type CategorySeed struct {
	Slug      string `yaml:"slug"`
	ZH        string `yaml:"zh"`
	EN        string `yaml:"en"`
	Icon      string `yaml:"icon"`
	AppliesTo string `yaml:"appliesTo"`
	Hidden    bool   `yaml:"hidden"`
	Sort      int    `yaml:"sort"`
}
type RoleSeed struct {
	Code string `yaml:"code"`
	Name string `yaml:"name"`
}
type PermissionSeed struct {
	Code  string   `yaml:"code"`
	Name  string   `yaml:"name"`
	Roles []string `yaml:"roles"`
}
type MirrorSeed struct {
	Key           string  `yaml:"key"`
	ZH            string  `yaml:"zh"`
	EN            string  `yaml:"en"`
	APIDomain     *string `yaml:"apiDomain"`
	BottleDomain  *string `yaml:"bottleDomain"`
	BrewGitRemote *string `yaml:"brewGitRemote"`
	CoreGitRemote *string `yaml:"coreGitRemote"`
	ProbeURL      string  `yaml:"probeURL"`
	Sort          int     `yaml:"sort"`
}
type ConfigSeed struct {
	Key         string `yaml:"key"`
	Value       string `yaml:"value"`
	Description string `yaml:"description"`
}
type SeedData struct {
	Categories  []CategorySeed   `yaml:"categories"`
	Roles       []RoleSeed       `yaml:"roles"`
	Permissions []PermissionSeed `yaml:"permissions"`
	Mirrors     []MirrorSeed     `yaml:"mirrors"`
	Configs     []ConfigSeed     `yaml:"configs"`
}
