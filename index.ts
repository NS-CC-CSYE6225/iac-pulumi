import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const vpcCidrBlock = new pulumi.Config().require("vpcCidrBlock");

const vpc = new aws.ec2.Vpc("my-vpc", {
    cidrBlock: vpcCidrBlock,
    enableDnsSupport: true,
    enableDnsHostnames: true,
});

const publicCidrBlocks = JSON.parse(new pulumi.Config().require("publicCidrBlocks"));
const privateCidrBlocks = JSON.parse(new pulumi.Config().require("privateCidrBlocks"));
const publicRouteCidrBlock = new pulumi.Config().require("publicRouteCidrBlock");
const PublicRouteTable = new pulumi.Config().require("publicRouteTable");
const PrivateRouteTable = new pulumi.Config().require("privateRouteTable");
const PublicRoute = new pulumi.Config().require("publicRoute");
const PublicSubnet = new pulumi.Config().require("publicSubnet");
const PrivateSubnet = new pulumi.Config().require("privateSubnet");
const PublicSubnetAssociation = new pulumi.Config().require("publicSubnetAssociation");
const PrivateSubnetAssociation = new pulumi.Config().require("privateSubnetAssociation");


const internetGateway = new aws.ec2.InternetGateway("my-igw", {
    vpcId: vpc.id,
});

// Create subnets in different availability zones
const availabilityZones = aws.getAvailabilityZones({ state: "available" });

const Privatesubnets: aws.ec2.Subnet[] = [];
const Publicsubnets: aws.ec2.Subnet[] = [];

availabilityZones.then(azs => {
    const numofAZS = Math.min(3, azs.names.length);

    for (let i = 0; i < numofAZS; i++) {
        const availabilityZone = azs.names[i];

        // Create public subnet
        const publicSubnet = new aws.ec2.Subnet(`${PublicSubnet}${i}`, {
            cidrBlock: publicCidrBlocks[i],
            vpcId: vpc.id,
            availabilityZone: availabilityZone,
            mapPublicIpOnLaunch: true,
        });
        Publicsubnets.push(publicSubnet);

        // Create private subnet
        const privateSubnet = new aws.ec2.Subnet(`${PrivateSubnet}${i}`, {
            cidrBlock: privateCidrBlocks[i],
            vpcId: vpc.id,
            availabilityZone: availabilityZone,
        });
        Privatesubnets.push(privateSubnet);
    }

    const publicRouteTable = new aws.ec2.RouteTable(PublicRouteTable, {
        vpcId: vpc.id,
    });

    Publicsubnets.forEach((publicSubnet, i) => {
        new aws.ec2.RouteTableAssociation(`${PublicSubnetAssociation}${i}`, {
            routeTableId: publicRouteTable.id,
            subnetId: publicSubnet.id,
        });
    });

    const privateRouteTable = new aws.ec2.RouteTable(PrivateRouteTable, {
        vpcId: vpc.id,
    });

    Privatesubnets.forEach((privateSubnet, i) => {
        new aws.ec2.RouteTableAssociation(`${PrivateSubnetAssociation}${i}`, {
            routeTableId: privateRouteTable.id,
            subnetId: privateSubnet.id,
        });
    });

    // Create the public route
    const publicRoute = new aws.ec2.Route(PublicRoute, {
        routeTableId: publicRouteTable.id,
        destinationCidrBlock: publicRouteCidrBlock,
        gatewayId: internetGateway.id,
    });

});

export const vpcId = vpc.id;
export const publicSubnetIds = Publicsubnets.map(subnet => subnet.id);
export const privateSubnetIds = Privatesubnets.map(subnet => subnet.id);
